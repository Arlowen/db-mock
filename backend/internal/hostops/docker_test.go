package hostops

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

type localShellRunner struct{}

func (localShellRunner) Probe(context.Context, domain.Host) (ProbeResult, error) {
	return ProbeResult{}, nil
}

func (localShellRunner) Run(ctx context.Context, _ domain.Host, command string, stdin io.Reader) (CommandResult, error) {
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Stdin = stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	result := CommandResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if exitErr, ok := err.(*exec.ExitError); ok {
		result.ExitCode = exitErr.ExitCode()
	}
	return result, err
}

func (localShellRunner) WriteFile(_ context.Context, _ domain.Host, target string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, data, mode)
}

func (localShellRunner) UploadFile(context.Context, domain.Host, string, string, func(int64, int64)) error {
	return nil
}

type recordingRunner struct {
	commands  []string
	writes    []string
	failFirst bool
}

func (*recordingRunner) Probe(context.Context, domain.Host) (ProbeResult, error) {
	return ProbeResult{}, nil
}

func (runner *recordingRunner) Run(_ context.Context, _ domain.Host, command string, _ io.Reader) (CommandResult, error) {
	runner.commands = append(runner.commands, command)
	if runner.failFirst && len(runner.commands) == 1 {
		return CommandResult{}, errors.New("fixture failure")
	}
	return CommandResult{}, nil
}

func (runner *recordingRunner) WriteFile(_ context.Context, _ domain.Host, target string, _ []byte, _ os.FileMode) error {
	runner.writes = append(runner.writes, target)
	return nil
}

func (*recordingRunner) UploadFile(context.Context, domain.Host, string, string, func(int64, int64)) error {
	return nil
}

func TestValidateManagedDirectory(t *testing.T) {
	if err := validateManagedDirectory("/opt/dbmock", "/opt/dbmock/instances/123"); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"/", "/opt/dbmock", "/opt/dbmock/other", "/opt/dbmock/instances/../outside"} {
		if err := validateManagedDirectory("/opt/dbmock", value); err == nil {
			t.Fatalf("expected %q to fail", value)
		}
	}
}

func TestValidateProjectUsesComposeConfigWithoutStartingContainers(t *testing.T) {
	runner := &recordingRunner{}
	docker := &Docker{runner: runner}
	instance := domain.Instance{RemoteDirectory: "/opt/dbmock/instances/id", ComposeProject: "dbmock_id"}
	if err := docker.ValidateProject(context.Background(), domain.Host{}, instance); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 1 || !strings.Contains(runner.commands[0], " config --quiet") {
		t.Fatalf("unexpected validation command: %#v", runner.commands)
	}
	if strings.Contains(runner.commands[0], " up ") || strings.Contains(runner.commands[0], " start") {
		t.Fatalf("validation must not start containers: %s", runner.commands[0])
	}
}

func TestComposeStartReconcilesTheStoredProjectBeforeStarting(t *testing.T) {
	runner := &recordingRunner{}
	docker := &Docker{runner: runner}
	instance := domain.Instance{RemoteDirectory: "/opt/dbmock/instances/id", ComposeProject: "dbmock_id"}
	if err := docker.ComposeStart(context.Background(), domain.Host{}, instance); err != nil {
		t.Fatal(err)
	}
	if len(runner.commands) != 1 || !strings.Contains(runner.commands[0], " up -d ") ||
		!strings.Contains(runner.commands[0], "--wait") {
		t.Fatalf("start must reconcile the saved Compose project: %#v", runner.commands)
	}
	if strings.Contains(runner.commands[0], " compose start") {
		t.Fatalf("plain compose start would retain stale stopped-container settings: %s", runner.commands[0])
	}
}

func TestWriteProjectRejectsPlatformOwnedAndCaseCollidingPackageFilesBeforeWriting(t *testing.T) {
	instance := domain.Instance{RemoteDirectory: "/opt/dbmock/instances/id"}
	host := domain.Host{DataRoot: "/opt/dbmock"}
	for name, files := range map[string]map[string][]byte{
		"generated environment": {".env": []byte("overridden")},
		"managed manifest":      {".dbmock-managed-files": []byte("outside")},
		"database data":         {"data/database.bin": []byte("outside")},
		"runtime state":         {"RUNTIME/database.pid": []byte("outside")},
		"case collision": {
			"config/database.cnf": []byte("first"),
			"CONFIG/DATABASE.CNF": []byte("second"),
		},
		"file and child collision": {
			"config":              []byte("file"),
			"config/database.cnf": []byte("child"),
		},
	} {
		t.Run(name, func(t *testing.T) {
			runner := &recordingRunner{}
			docker := &Docker{runner: runner}
			if err := docker.WriteProject(context.Background(), host, instance, []byte("services: {}"), nil, files, nil); err == nil {
				t.Fatal("expected package file validation to fail")
			}
			if len(runner.commands) != 0 || len(runner.writes) != 0 {
				t.Fatalf("validation must happen before remote writes: commands=%#v writes=%#v", runner.commands, runner.writes)
			}
		})
	}
}

func TestWriteProjectReconcilesManagedTemplateFilesWithoutTouchingRuntimeData(t *testing.T) {
	root := filepath.ToSlash(t.TempDir())
	instanceDirectory := root + "/instances/11111111-1111-4111-8111-111111111111"
	host := domain.Host{DataRoot: root}
	instance := domain.Instance{RemoteDirectory: instanceDirectory}
	docker := &Docker{runner: localShellRunner{}}
	first := map[string][]byte{
		"config/obsolete.cnf": []byte("obsolete=true\n"),
		"scripts/upgrade.sh":  []byte("#!/bin/sh\n"),
	}
	if err := docker.WriteProject(context.Background(), host, instance, []byte("services: {old: {}}\n"), []byte("OLD=true\n"), first, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(instanceDirectory, managedProjectFilesManifest)); err != nil {
		t.Fatal(err)
	}
	dataFile := filepath.Join(instanceDirectory, "data", "database.bin")
	if err := os.MkdirAll(filepath.Dir(dataFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dataFile, []byte("persistent data"), 0o600); err != nil {
		t.Fatal(err)
	}
	second := map[string][]byte{"config/current.cnf": []byte("current=true\n")}
	if err := docker.WriteProject(context.Background(), host, instance, []byte("services: {new: {}}\n"), []byte("NEW=true\n"), second, first); err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{"config/obsolete.cnf", "scripts/upgrade.sh"} {
		if _, err := os.Stat(filepath.Join(instanceDirectory, removed)); !os.IsNotExist(err) {
			t.Fatalf("stale managed file %s was not removed: %v", removed, err)
		}
	}
	for relative, want := range map[string]string{
		"config/current.cnf":    "current=true\n",
		"data/database.bin":     "persistent data",
		"compose.yaml":          "services: {new: {}}\n",
		".env":                  "NEW=true\n",
		".dbmock-managed-files": "config/current.cnf\n",
	} {
		content, err := os.ReadFile(filepath.Join(instanceDirectory, relative))
		if err != nil || string(content) != want {
			t.Fatalf("project file %s = %q, %v; want %q", relative, content, err, want)
		}
	}
	if err := docker.WriteProject(context.Background(), host, instance, []byte("services: {old: {}}\n"), []byte("OLD=true\n"), first, second); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(instanceDirectory, "config", "current.cnf")); !os.IsNotExist(err) {
		t.Fatalf("rollback left the upgraded managed file behind: %v", err)
	}
	for relative, want := range map[string]string{
		"config/obsolete.cnf":   "obsolete=true\n",
		"scripts/upgrade.sh":    "#!/bin/sh\n",
		"data/database.bin":     "persistent data",
		".dbmock-managed-files": "config/obsolete.cnf\nscripts/upgrade.sh\n",
	} {
		content, err := os.ReadFile(filepath.Join(instanceDirectory, relative))
		if err != nil || string(content) != want {
			t.Fatalf("rolled-back project file %s = %q, %v; want %q", relative, content, err, want)
		}
	}
}

func TestWriteProjectRefusesTamperedManifestThatTargetsRuntimeData(t *testing.T) {
	root := filepath.ToSlash(t.TempDir())
	instanceDirectory := root + "/instances/11111111-1111-4111-8111-111111111111"
	dataFile := filepath.Join(instanceDirectory, "data", "database.bin")
	if err := os.MkdirAll(filepath.Dir(dataFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dataFile, []byte("persistent data"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(instanceDirectory, managedProjectFilesManifest)
	if err := os.WriteFile(manifest, []byte("data/database.bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	docker := &Docker{runner: localShellRunner{}}
	err := docker.WriteProject(context.Background(), domain.Host{DataRoot: root},
		domain.Instance{RemoteDirectory: instanceDirectory}, []byte("services: {}\n"), nil, nil, nil)
	if err == nil {
		t.Fatal("expected a tampered managed-file manifest to stop project reconciliation")
	}
	content, readErr := os.ReadFile(dataFile)
	if readErr != nil || string(content) != "persistent data" {
		t.Fatalf("runtime data changed after refusing the manifest: %q, %v", content, readErr)
	}
}

func TestParseDockerSize(t *testing.T) {
	if got := parseDockerSize("1.5GiB"); got != 1610612736 {
		t.Fatalf("got %d", got)
	}
}

func TestParseManagedStatesAggregatesProcessAndHealth(t *testing.T) {
	states := parseManagedStates("one|running|healthy\none|running|unhealthy\n" +
		"two|running|starting\ntwo|running|healthy\n" +
		"three|exited|\nthree|dead|\n" +
		"four|running|healthy\nfour|exited|unhealthy\n")
	tests := map[string]ManagedState{
		"one":   {State: "running", Health: "unhealthy"},
		"two":   {State: "running", Health: "starting"},
		"three": {State: "stopped", Health: ""},
		"four":  {State: "degraded", Health: "unhealthy"},
	}
	for id, want := range tests {
		if got := states[id]; got != want {
			t.Errorf("state %s = %#v, want %#v", id, got, want)
		}
	}
}

func TestRegistryServerStripsURLScheme(t *testing.T) {
	if got := registryServer("https://harbor.example.com:5443/"); got != "harbor.example.com:5443" {
		t.Fatalf("got %q", got)
	}
}

func TestParseListeningTCPPortsSupportsLinuxAndMacOSFormats(t *testing.T) {
	ports := parseListeningTCPPorts("0.0.0.0:22\n[::]:5432\n*:8080\n*.6379\n127.0.0.1.27017\ninvalid\n*:70000\n")
	for _, port := range []int{22, 5432, 8080, 6379, 27017} {
		if _, ok := ports[port]; !ok {
			t.Errorf("expected port %d to be detected", port)
		}
	}
	if _, ok := ports[70000]; ok {
		t.Fatal("expected an out-of-range port to be ignored")
	}
}

func TestBackupArchivePathStaysInsideManagedBackupDirectory(t *testing.T) {
	docker := &Docker{}
	instanceID := uuid.MustParse("11111111-1111-4111-8111-111111111111")
	backupID := uuid.MustParse("22222222-2222-4222-8222-222222222222")
	host := domain.Host{DataRoot: "/opt/dbmock"}
	instance := domain.Instance{ID: instanceID, RemoteDirectory: "/opt/dbmock/instances/" + instanceID.String()}
	got, err := docker.BackupArchivePath(host, instance, backupID)
	if err != nil {
		t.Fatal(err)
	}
	want := "/opt/dbmock/backups/" + instanceID.String() + "/" + backupID.String() + ".tar.gz"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	instance.RemoteDirectory = "/opt/other/instances/" + instanceID.String()
	if _, err = docker.BackupArchivePath(host, instance, backupID); err == nil {
		t.Fatal("expected an instance outside the managed root to be rejected")
	}
}

func TestParseBackupArchiveInfoValidatesSizeAndDigest(t *testing.T) {
	digest := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	info, err := parseBackupArchiveInfo("diagnostic\n4096|"+digest+"\n", "/backup.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	if info.SizeBytes != 4096 || info.SHA256 != digest || info.Path != "/backup.tar.gz" {
		t.Fatalf("unexpected backup info: %#v", info)
	}
	for _, output := range []string{"0|" + digest, "4096|invalid", "missing"} {
		if _, err = parseBackupArchiveInfo(output, "/backup.tar.gz"); err == nil {
			t.Fatalf("expected %q to fail", output)
		}
	}
}

func TestDockerDataHelperUsesOnlyTheExistingIsolatedImage(t *testing.T) {
	command, err := dockerDataHelperCommand("postgres:17", "/opt/dbmock/instances/id:/target", restoreStreamScript("/target"), true)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"docker run", "--pull never", "--network none", "--read-only", "--user 0:0", "-i", "postgres:17", "/opt/dbmock/instances/id:/target"} {
		if !strings.Contains(command, required) {
			t.Fatalf("helper command does not contain %q: %s", required, command)
		}
	}
	for _, image := range []string{"", "postgres:17\nmalicious"} {
		if _, err = dockerDataHelperCommand(image, "/source:/source:ro", "true", false); err == nil {
			t.Fatalf("expected helper image %q to be rejected", image)
		}
	}
}

func TestUpgradeSnapshotStreamsToProtectedExternalDirectory(t *testing.T) {
	instanceID := uuid.MustParse("11111111-1111-4111-8111-111111111111")
	operationID := uuid.MustParse("22222222-2222-4222-8222-222222222222")
	host := domain.Host{DataRoot: "/opt/dbmock"}
	instance := domain.Instance{ID: instanceID, RemoteDirectory: "/opt/dbmock/instances/" + instanceID.String(), ComposeProject: "dbmock_fixture"}
	runner := &recordingRunner{}
	snapshot, err := NewDocker(runner).SnapshotForUpgrade(context.Background(), host, instance, operationID, false, "postgres:17")
	if err != nil {
		t.Fatal(err)
	}
	want := "/opt/dbmock/backups/.rollback/" + instanceID.String() + "/" + operationID.String() + ".tar.gz"
	if snapshot != want {
		t.Fatalf("snapshot = %q, want %q", snapshot, want)
	}
	if len(runner.commands) != 1 {
		t.Fatalf("commands = %#v", runner.commands)
	}
	for _, required := range []string{"docker run", "--pull never", instance.RemoteDirectory + ":/source:ro", want + ".tmp"} {
		if !strings.Contains(runner.commands[0], required) {
			t.Fatalf("snapshot command does not contain %q: %s", required, runner.commands[0])
		}
	}
	if strings.Contains(runner.commands[0], instance.RemoteDirectory+"/upgrade-snapshot") {
		t.Fatalf("snapshot must not be written inside the archived directory: %s", runner.commands[0])
	}
	if !strings.Contains(runner.commands[0], "rm -f -- "+ShellQuote(want)) {
		t.Fatalf("a new operation must replace only its own snapshot: %s", runner.commands[0])
	}

	resumed := &recordingRunner{}
	resumedSnapshot, err := NewDocker(resumed).SnapshotForUpgrade(context.Background(), host, instance, operationID, true, "postgres:17")
	if err != nil || resumedSnapshot != want {
		t.Fatalf("resumed snapshot = %q, err=%v", resumedSnapshot, err)
	}
	if len(resumed.commands) != 1 || !strings.Contains(resumed.commands[0], "test -s "+ShellQuote(want)) ||
		strings.Contains(resumed.commands[0], "rm -f -- "+ShellQuote(want)+" ") {
		t.Fatalf("an interrupted retry must preserve its completed snapshot: %#v", resumed.commands)
	}

	otherOperationID := uuid.MustParse("33333333-3333-4333-8333-333333333333")
	otherSnapshot, err := NewDocker(&recordingRunner{}).SnapshotForUpgrade(context.Background(), host, instance, otherOperationID, false, "postgres:17")
	if err != nil || otherSnapshot == want {
		t.Fatalf("independent operation snapshot = %q, err=%v", otherSnapshot, err)
	}
	if err = NewDocker(&recordingRunner{}).RestoreUpgradeSnapshot(context.Background(), host, instance, operationID, otherSnapshot, "postgres:17"); err == nil {
		t.Fatal("a snapshot from another operation must be rejected")
	}
	restoreRunner := &recordingRunner{}
	if err = NewDocker(restoreRunner).RestoreUpgradeSnapshot(context.Background(), host, instance, operationID, want, "postgres:17"); err != nil {
		t.Fatal(err)
	}
	if len(restoreRunner.commands) != 1 || !strings.Contains(restoreRunner.commands[0], "test ! -L "+ShellQuote(want)) {
		t.Fatalf("restore did not validate its operation snapshot: %#v", restoreRunner.commands)
	}
	cleanupRunner := &recordingRunner{}
	if err = NewDocker(cleanupRunner).DeleteUpgradeSnapshot(context.Background(), host, instance, operationID); err != nil {
		t.Fatal(err)
	}
	if len(cleanupRunner.commands) != 1 || !strings.Contains(cleanupRunner.commands[0], "rm -f -- "+ShellQuote(want)) ||
		strings.Contains(cleanupRunner.commands[0], "rm -rf") {
		t.Fatalf("operation cleanup was broader than its snapshot: %#v", cleanupRunner.commands)
	}
	instanceCleanupRunner := &recordingRunner{}
	if err = NewDocker(instanceCleanupRunner).DeleteInstanceRollbackSnapshots(context.Background(), host, instance); err != nil {
		t.Fatal(err)
	}
	rollbackDirectory := "/opt/dbmock/backups/.rollback/" + instanceID.String()
	if len(instanceCleanupRunner.commands) != 1 || !strings.Contains(instanceCleanupRunner.commands[0], "rm -rf -- "+ShellQuote(rollbackDirectory)) {
		t.Fatalf("instance cleanup did not target its exact rollback directory: %#v", instanceCleanupRunner.commands)
	}

	failing := &recordingRunner{failFirst: true}
	if snapshot, err = NewDocker(failing).SnapshotForUpgrade(context.Background(), host, instance, operationID, false, "postgres:17"); err == nil || snapshot != "" {
		t.Fatalf("failed snapshot = %q, err = %v", snapshot, err)
	}
	if len(failing.commands) != 2 || !strings.Contains(failing.commands[1], ".tmp") {
		t.Fatalf("failed snapshot did not clean its temporary archive: %#v", failing.commands)
	}
}

func TestInterruptedSnapshotRetryPreservesTheOriginalArchive(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	fakeDocker := filepath.Join(bin, "docker")
	if err := os.WriteFile(fakeDocker, []byte(`#!/bin/sh
set -eu
if [ "${1:-}" = "run" ]; then
  printf '%s' "${FAKE_ARCHIVE_CONTENT:?}"
fi
`), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_ARCHIVE_CONTENT", "original-before-interruption")

	instanceID, operationID := uuid.New(), uuid.New()
	host := domain.Host{DataRoot: root}
	instance := domain.Instance{ID: instanceID, RemoteDirectory: filepath.Join(root, "instances", instanceID.String()), ComposeProject: "dbmock_fixture"}
	docker := NewDocker(localShellRunner{})
	snapshot, err := docker.SnapshotForUpgrade(context.Background(), host, instance, operationID, false, "postgres:17")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_ARCHIVE_CONTENT", "partially-modified-retry-state")
	if _, err = docker.SnapshotForUpgrade(context.Background(), host, instance, operationID, true, "postgres:17"); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(snapshot)
	if err != nil || string(content) != "original-before-interruption" {
		t.Fatalf("resumed snapshot = %q, err=%v", content, err)
	}

	if _, err = docker.SnapshotForUpgrade(context.Background(), host, instance, operationID, false, "postgres:17"); err != nil {
		t.Fatal(err)
	}
	content, err = os.ReadFile(snapshot)
	if err != nil || string(content) != "partially-modified-retry-state" {
		t.Fatalf("fresh retry snapshot = %q, err=%v", content, err)
	}
}

func TestBackupArchiveLifecyclePreservesManagedInstanceFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "managed root")
	instanceID := uuid.MustParse("11111111-1111-4111-8111-111111111111")
	backupID := uuid.MustParse("22222222-2222-4222-8222-222222222222")
	instanceDirectory := filepath.Join(root, "instances", instanceID.String())
	dataDirectory := filepath.Join(instanceDirectory, "data")
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(instanceDirectory, ".env"), []byte("DB_PASSWORD=protected\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dataFile := filepath.Join(dataDirectory, "value.txt")
	if err := os.WriteFile(dataFile, []byte("before backup"), 0o600); err != nil {
		t.Fatal(err)
	}

	runner := localShellRunner{}
	docker := NewDocker(runner)
	host := domain.Host{DataRoot: root}
	instance := domain.Instance{ID: instanceID, RemoteDirectory: instanceDirectory}
	archivePath, err := docker.BackupArchivePath(host, instance, backupID)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(archivePath), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := runner.Run(context.Background(), host, `set -eu; umask 077; `+archiveStreamScript(instanceDirectory)+` > `+ShellQuote(archivePath)+`; chmod 0600 `+ShellQuote(archivePath)+`; `+backupDigestCommand(archivePath), nil)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := parseBackupArchiveInfo(result.Stdout, archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if archive.SizeBytes <= 0 || len(archive.SHA256) != 64 {
		t.Fatalf("invalid archive metadata: %#v", archive)
	}
	info, err := os.Stat(archive.Path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("archive permissions = %o, want 600", info.Mode().Perm())
	}
	inspected, err := docker.InspectBackupArchive(context.Background(), host, instance, backupID)
	if err != nil {
		t.Fatal(err)
	}
	if inspected.SizeBytes != archive.SizeBytes || inspected.SHA256 != archive.SHA256 {
		t.Fatalf("inspected metadata = %#v, want %#v", inspected, archive)
	}

	if err = os.WriteFile(dataFile, []byte("after backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	extraFile := filepath.Join(instanceDirectory, "created-after-backup")
	if err = os.WriteFile(extraFile, []byte("remove me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err = runner.Run(context.Background(), host, restoreStreamScript(instanceDirectory)+` < `+ShellQuote(archive.Path), nil); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != "before backup" {
		t.Fatalf("restored content = %q", restored)
	}
	if _, err = os.Stat(extraFile); !os.IsNotExist(err) {
		t.Fatalf("expected post-backup file to be removed, got %v", err)
	}
	if env, readErr := os.ReadFile(filepath.Join(instanceDirectory, ".env")); readErr != nil || string(env) != "DB_PASSWORD=protected\n" {
		t.Fatalf("restored .env = %q, err = %v", env, readErr)
	}
	if err = docker.DeleteBackupArchive(context.Background(), host, instance, backupID); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(archive.Path); !os.IsNotExist(err) {
		t.Fatalf("expected archive deletion, got %v", err)
	}
}

func TestDockerDataHelperArchivesContainerOwnedFiles(t *testing.T) {
	if os.Getenv("DBMOCK_DOCKER_INTEGRATION") != "1" {
		t.Skip("set DBMOCK_DOCKER_INTEGRATION=1 to exercise the local Docker engine")
	}
	image := os.Getenv("DBMOCK_DOCKER_TEST_IMAGE")
	if image == "" {
		image = "postgres:17-alpine"
	}
	root := filepath.Join(t.TempDir(), "managed root")
	instanceID := uuid.MustParse("33333333-3333-4333-8333-333333333333")
	backupID := uuid.MustParse("44444444-4444-4444-8444-444444444444")
	instanceDirectory := filepath.Join(root, "instances", instanceID.String())
	if err := os.MkdirAll(instanceDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	runner := localShellRunner{}
	initialize, err := dockerDataHelperCommand(image, instanceDirectory+":/target", `set -eu; mkdir -p /target/data; printf 'before backup' > /target/data/value.txt; chmod 0700 /target/data; chmod 0600 /target/data/value.txt`, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = runner.Run(context.Background(), domain.Host{}, initialize, nil); err != nil {
		t.Fatalf("initialize container-owned data: %v", err)
	}

	docker := NewDocker(runner)
	host := domain.Host{DataRoot: root}
	instance := domain.Instance{ID: instanceID, RemoteDirectory: instanceDirectory}
	archive, err := docker.CreateBackupArchive(context.Background(), host, instance, backupID, image)
	if err != nil {
		t.Fatal(err)
	}
	mutate, _ := dockerDataHelperCommand(image, instanceDirectory+":/target", `set -eu; printf 'after backup' > /target/data/value.txt; printf 'remove me' > /target/extra.txt`, false)
	if _, err = runner.Run(context.Background(), host, mutate, nil); err != nil {
		t.Fatal(err)
	}
	if err = docker.RestoreBackupArchive(context.Background(), host, instance, backupID, image); err != nil {
		t.Fatal(err)
	}
	verify, _ := dockerDataHelperCommand(image, instanceDirectory+":/target:ro", `set -eu; cat /target/data/value.txt; test ! -e /target/extra.txt`, false)
	result, err := runner.Run(context.Background(), host, verify, nil)
	if err != nil || result.Stdout != "before backup" {
		t.Fatalf("verify restored container-owned data: stdout=%q stderr=%q err=%v", result.Stdout, result.Stderr, err)
	}
	if err = docker.DeleteBackupArchive(context.Background(), host, instance, backupID); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(archive.Path); !os.IsNotExist(err) {
		t.Fatalf("expected archive deletion, got %v", err)
	}
}
