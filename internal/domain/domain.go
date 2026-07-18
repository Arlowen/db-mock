package domain

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound      = errors.New("resource not found")
	ErrConflict      = errors.New("resource conflict")
	ErrUnauthorized  = errors.New("authentication required")
	ErrForbidden     = errors.New("operation forbidden")
	ErrInvalid       = errors.New("invalid input")
	ErrNotConfigured = errors.New("platform is not initialized")
	ErrUnavailable   = errors.New("resource temporarily unavailable")
)

type User struct {
	ID           uuid.UUID  `json:"id"`
	Username     string     `json:"username"`
	DisplayName  string     `json:"displayName"`
	Locale       string     `json:"locale"`
	DisabledAt   *time.Time `json:"disabledAt,omitempty"`
	LastLoginAt  *time.Time `json:"lastLoginAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	PasswordHash string     `json:"-"`
}

type Session struct {
	ID        uuid.UUID `json:"id"`
	UserID    uuid.UUID `json:"userId"`
	TokenHash []byte    `json:"-"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
	LastSeen  time.Time `json:"lastSeen"`
	IP        string    `json:"ip"`
	UserAgent string    `json:"userAgent"`
}

type Project struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Color       string    `json:"color"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type Host struct {
	ID                  uuid.UUID       `json:"id"`
	ProjectID           *uuid.UUID      `json:"projectId,omitempty"`
	Name                string          `json:"name"`
	SSHAddress          string          `json:"sshAddress"`
	SSHPort             int             `json:"sshPort"`
	SSHUser             string          `json:"sshUser"`
	AuthType            string          `json:"authType"`
	EncryptedCredential string          `json:"-"`
	HostKey             string          `json:"hostKey,omitempty"`
	ConnectionAddress   string          `json:"connectionAddress"`
	DataRoot            string          `json:"dataRoot"`
	PortStart           int             `json:"portStart"`
	PortEnd             int             `json:"portEnd"`
	ManageDocker        bool            `json:"manageDocker"`
	ProxyHTTP           string          `json:"proxyHttp,omitempty"`
	ProxyHTTPS          string          `json:"proxyHttps,omitempty"`
	ProxyNoProxy        string          `json:"proxyNoProxy,omitempty"`
	OS                  string          `json:"os,omitempty"`
	Distro              string          `json:"distro,omitempty"`
	Architecture        string          `json:"architecture,omitempty"`
	DockerVersion       string          `json:"dockerVersion,omitempty"`
	ComposeVersion      string          `json:"composeVersion,omitempty"`
	CPUCount            float64         `json:"cpuCount"`
	MemoryBytes         int64           `json:"memoryBytes"`
	DiskTotalBytes      int64           `json:"diskTotalBytes"`
	DiskFreeBytes       int64           `json:"diskFreeBytes"`
	Status              string          `json:"status"`
	StatusMessage       string          `json:"statusMessage,omitempty"`
	Maintenance         bool            `json:"maintenance"`
	AutoRestartDefault  bool            `json:"autoRestartDefault"`
	LastSeenAt          *time.Time      `json:"lastSeenAt,omitempty"`
	LastCheckedAt       *time.Time      `json:"lastCheckedAt,omitempty"`
	ConsecutiveFailures int             `json:"consecutiveFailures"`
	Labels              json.RawMessage `json:"labels"`
	CreatedAt           time.Time       `json:"createdAt"`
	UpdatedAt           time.Time       `json:"updatedAt"`
}

type Registry struct {
	ID                     uuid.UUID  `json:"id"`
	Name                   string     `json:"name"`
	URL                    string     `json:"url"`
	Username               string     `json:"username,omitempty"`
	EncryptedPassword      string     `json:"-"`
	EncryptedCACertificate string     `json:"-"`
	HasPassword            bool       `json:"hasPassword"`
	HasCACertificate       bool       `json:"hasCaCertificate"`
	CreatedAt              time.Time  `json:"createdAt"`
	UpdatedAt              time.Time  `json:"updatedAt"`
	LastTestedAt           *time.Time `json:"lastTestedAt,omitempty"`
	Status                 string     `json:"status"`
}

type Template struct {
	ID          uuid.UUID         `json:"id"`
	Slug        string            `json:"slug"`
	Name        string            `json:"name"`
	NameZH      string            `json:"nameZh"`
	Description string            `json:"description"`
	Category    string            `json:"category"`
	Tier        string            `json:"tier"`
	Builtin     bool              `json:"builtin"`
	Icon        string            `json:"icon"`
	RiskReport  json.RawMessage   `json:"riskReport"`
	CreatedAt   time.Time         `json:"createdAt"`
	UpdatedAt   time.Time         `json:"updatedAt"`
	Versions    []TemplateVersion `json:"versions,omitempty"`
}

type TemplateVersion struct {
	ID              uuid.UUID       `json:"id"`
	TemplateID      uuid.UUID       `json:"templateId"`
	Version         string          `json:"version"`
	ImageReference  string          `json:"imageReference"`
	Architectures   []string        `json:"architectures"`
	MinCPU          float64         `json:"minCpu"`
	MinMemoryBytes  int64           `json:"minMemoryBytes"`
	MinDiskBytes    int64           `json:"minDiskBytes"`
	DefaultPort     int             `json:"defaultPort"`
	ComposeTemplate string          `json:"-"`
	Manifest        json.RawMessage `json:"manifest"`
	PackagePath     string          `json:"-"`
	Immutable       bool            `json:"immutable"`
	CreatedAt       time.Time       `json:"createdAt"`
}

type Instance struct {
	ID                uuid.UUID       `json:"id"`
	Name              string          `json:"name"`
	ProjectID         *uuid.UUID      `json:"projectId,omitempty"`
	HostID            uuid.UUID       `json:"hostId"`
	TemplateVersionID uuid.UUID       `json:"templateVersionId"`
	Environment       string          `json:"environment"`
	Labels            json.RawMessage `json:"labels"`
	Status            string          `json:"status"`
	StatusMessage     string          `json:"statusMessage,omitempty"`
	DesiredState      string          `json:"desiredState"`
	AutoRestart       bool            `json:"autoRestart"`
	RestartFailures   int             `json:"restartFailures"`
	CPU               float64         `json:"cpu"`
	MemoryBytes       int64           `json:"memoryBytes"`
	ReservedDiskBytes int64           `json:"reservedDiskBytes"`
	HostPort          int             `json:"hostPort"`
	ContainerPort     int             `json:"containerPort"`
	BindAddress       string          `json:"bindAddress"`
	DatabaseUsername  string          `json:"databaseUsername"`
	EncryptedPassword string          `json:"-"`
	HasPassword       bool            `json:"hasPassword"`
	DatabaseName      string          `json:"databaseName"`
	ConnectionURI     string          `json:"connectionUri,omitempty"`
	JDBCURI           string          `json:"jdbcUri,omitempty"`
	ComposeProject    string          `json:"composeProject"`
	RemoteDirectory   string          `json:"remoteDirectory"`
	Configuration     json.RawMessage `json:"configuration"`
	TemplateSlug      string          `json:"templateSlug,omitempty"`
	TemplateName      string          `json:"templateName,omitempty"`
	TemplateVersion   string          `json:"templateVersion,omitempty"`
	HostName          string          `json:"hostName,omitempty"`
	ConnectionAddress string          `json:"connectionAddress,omitempty"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
	LastHealthyAt     *time.Time      `json:"lastHealthyAt,omitempty"`
}

type InstanceConnection struct {
	Address  string `json:"address"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	Database string `json:"database"`
	URI      string `json:"uri"`
	JDBC     string `json:"jdbc,omitempty"`
}

type Task struct {
	ID           uuid.UUID       `json:"id"`
	Kind         string          `json:"kind"`
	Status       string          `json:"status"`
	ResourceType string          `json:"resourceType"`
	ResourceID   *uuid.UUID      `json:"resourceId,omitempty"`
	RequestedBy  uuid.UUID       `json:"requestedBy"`
	HostID       *uuid.UUID      `json:"hostId,omitempty"`
	Progress     int             `json:"progress"`
	Stage        string          `json:"stage"`
	Message      string          `json:"message"`
	Payload      json.RawMessage `json:"payload"`
	Result       json.RawMessage `json:"result,omitempty"`
	ErrorCode    string          `json:"errorCode,omitempty"`
	ErrorMessage string          `json:"errorMessage,omitempty"`
	Cancelable   bool            `json:"cancelable"`
	CancelAsked  bool            `json:"cancelAsked"`
	Attempts     int             `json:"attempts"`
	CreatedAt    time.Time       `json:"createdAt"`
	StartedAt    *time.Time      `json:"startedAt,omitempty"`
	FinishedAt   *time.Time      `json:"finishedAt,omitempty"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

type TaskLog struct {
	ID        int64     `json:"id"`
	TaskID    uuid.UUID `json:"taskId"`
	Level     string    `json:"level"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"createdAt"`
}

type MetricSample struct {
	ID             int64      `json:"id"`
	HostID         uuid.UUID  `json:"hostId"`
	InstanceID     *uuid.UUID `json:"instanceId,omitempty"`
	CPUPercent     float64    `json:"cpuPercent"`
	MemoryBytes    int64      `json:"memoryBytes"`
	MemoryPercent  float64    `json:"memoryPercent"`
	DiskUsedBytes  int64      `json:"diskUsedBytes"`
	DiskTotalBytes int64      `json:"diskTotalBytes"`
	CollectedAt    time.Time  `json:"collectedAt"`
}

type Alert struct {
	ID             uuid.UUID       `json:"id"`
	Severity       string          `json:"severity"`
	Type           string          `json:"type"`
	ResourceType   string          `json:"resourceType"`
	ResourceID     uuid.UUID       `json:"resourceId"`
	Title          string          `json:"title"`
	Message        string          `json:"message"`
	Details        json.RawMessage `json:"details"`
	Status         string          `json:"status"`
	CreatedAt      time.Time       `json:"createdAt"`
	AcknowledgedAt *time.Time      `json:"acknowledgedAt,omitempty"`
	ResolvedAt     *time.Time      `json:"resolvedAt,omitempty"`
}

type Webhook struct {
	ID              uuid.UUID       `json:"id"`
	Name            string          `json:"name"`
	URL             string          `json:"url"`
	EncryptedSecret string          `json:"-"`
	HasSecret       bool            `json:"hasSecret"`
	Events          json.RawMessage `json:"events"`
	Enabled         bool            `json:"enabled"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
}

type WebhookDelivery struct {
	ID             uuid.UUID `json:"id"`
	WebhookID      uuid.UUID `json:"webhookId"`
	EventID        uuid.UUID `json:"eventId"`
	EventType      string    `json:"eventType"`
	Status         string    `json:"status"`
	Attempts       int       `json:"attempts"`
	NextAttemptAt  time.Time `json:"nextAttemptAt"`
	ResponseStatus *int      `json:"responseStatus,omitempty"`
	ResponseBody   string    `json:"responseBody,omitempty"`
	ErrorMessage   string    `json:"errorMessage,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type AuditLog struct {
	ID           int64           `json:"id"`
	UserID       *uuid.UUID      `json:"userId,omitempty"`
	Username     string          `json:"username,omitempty"`
	Action       string          `json:"action"`
	ResourceType string          `json:"resourceType"`
	ResourceID   *uuid.UUID      `json:"resourceId,omitempty"`
	ResourceName string          `json:"resourceName,omitempty"`
	IP           string          `json:"ip"`
	RequestID    string          `json:"requestId"`
	TaskID       *uuid.UUID      `json:"taskId,omitempty"`
	Result       string          `json:"result"`
	Changes      json.RawMessage `json:"changes"`
	Message      string          `json:"message"`
	CreatedAt    time.Time       `json:"createdAt"`
}

type ImageArtifact struct {
	ID            uuid.UUID  `json:"id"`
	Name          string     `json:"name"`
	Filename      string     `json:"filename"`
	Path          string     `json:"-"`
	SizeBytes     int64      `json:"sizeBytes"`
	SHA256        string     `json:"sha256"`
	Format        string     `json:"format"`
	ImageRefs     []string   `json:"imageRefs"`
	Architectures []string   `json:"architectures"`
	Status        string     `json:"status"`
	CreatedBy     uuid.UUID  `json:"createdBy"`
	CreatedAt     time.Time  `json:"createdAt"`
	LastUsedAt    *time.Time `json:"lastUsedAt,omitempty"`
}

type Upload struct {
	ID             uuid.UUID `json:"id"`
	Filename       string    `json:"filename"`
	TemporaryPath  string    `json:"-"`
	TotalBytes     int64     `json:"totalBytes"`
	ReceivedBytes  int64     `json:"receivedBytes"`
	ExpectedSHA256 string    `json:"expectedSha256"`
	Status         string    `json:"status"`
	CreatedBy      uuid.UUID `json:"createdBy"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type Dashboard struct {
	Hosts       map[string]int `json:"hosts"`
	Instances   map[string]int `json:"instances"`
	ActiveTasks int            `json:"activeTasks"`
	OpenAlerts  int            `json:"openAlerts"`
	Users       int            `json:"users"`
	Projects    int            `json:"projects"`
}
