package templates

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/pika/db-mock/internal/store"
)

const (
	GiB = int64(1024 * 1024 * 1024)
)

type Definition struct {
	Slug          string
	Name          string
	NameZH        string
	Description   string
	Category      string
	Tier          string
	Icon          string
	Version       string
	Image         string
	Architectures []string
	MinCPU        float64
	MinMemory     int64
	MinDisk       int64
	Port          int
	Username      string
	Database      string
	Scheme        string
	JDBCScheme    string
	DataTarget    string
	Environment   map[string]string
	Command       []string
	Healthcheck   []string
	Privileged    bool
	Tuning        []string
	Compose       string
}

func Seed(ctx context.Context, target *store.Store) error {
	for _, definition := range Builtins() {
		manifest := map[string]any{
			"username":      definition.Username,
			"database":      definition.Database,
			"scheme":        definition.Scheme,
			"jdbcScheme":    definition.JDBCScheme,
			"containerPort": definition.Port,
			"environment":   definition.Environment,
			"command":       definition.Command,
			"hostTuning":    definition.Tuning,
			"resourceProfiles": []map[string]any{
				{"name": "small", "cpu": definition.MinCPU, "memoryBytes": definition.MinMemory, "diskBytes": definition.MinDisk},
				{"name": "medium", "cpu": maxFloat(definition.MinCPU*2, 2), "memoryBytes": definition.MinMemory * 2, "diskBytes": definition.MinDisk * 2},
				{"name": "large", "cpu": maxFloat(definition.MinCPU*4, 4), "memoryBytes": definition.MinMemory * 4, "diskBytes": definition.MinDisk * 4},
			},
			"fields": []map[string]any{
				{"key": "databaseName", "type": "text", "required": false, "label": "Database name", "labelZh": "数据库名称"},
				{"key": "username", "type": "text", "required": true, "label": "Username", "labelZh": "用户名"},
			},
		}
		encoded, _ := json.Marshal(manifest)
		compose := definition.Compose
		if compose == "" {
			compose = singleServiceCompose(definition)
		}
		_, err := target.UpsertTemplate(ctx, store.TemplateInput{
			Slug: definition.Slug, Name: definition.Name, NameZH: definition.NameZH,
			Description: definition.Description, Category: definition.Category, Tier: definition.Tier,
			Builtin: true, Icon: definition.Icon,
		}, store.TemplateVersionInput{
			Version: definition.Version, ImageReference: definition.Image, Architectures: definition.Architectures,
			MinCPU: definition.MinCPU, MinMemoryBytes: definition.MinMemory, MinDiskBytes: definition.MinDisk,
			DefaultPort: definition.Port, ComposeTemplate: compose, Manifest: encoded,
		})
		if err != nil {
			return fmt.Errorf("seed template %s: %w", definition.Slug, err)
		}
	}
	return nil
}

func Builtins() []Definition {
	standard := "standard"
	experimental := "experimental"
	return []Definition{
		{Slug: "mysql", Name: "MySQL", NameZH: "MySQL", Description: "Popular relational database", Category: "relational", Tier: standard, Icon: "MY", Version: "8.4", Image: "mysql:8.4", Architectures: both(), MinCPU: 1, MinMemory: GiB, MinDisk: 10 * GiB, Port: 3306, Username: "dbmock", Database: "app", Scheme: "mysql", JDBCScheme: "mysql", DataTarget: "/var/lib/mysql", Environment: map[string]string{"MYSQL_ROOT_PASSWORD": "${DB_PASSWORD}", "MYSQL_DATABASE": "${DB_NAME}", "MYSQL_USER": "${DB_USERNAME}", "MYSQL_PASSWORD": "${DB_PASSWORD}"}, Healthcheck: []string{"CMD-SHELL", "mysqladmin ping -h localhost -p\"$${DBMOCK_DB_PASSWORD}\""}},
		{Slug: "mariadb", Name: "MariaDB", NameZH: "MariaDB", Description: "Community relational database compatible with MySQL", Category: "relational", Tier: standard, Icon: "MA", Version: "11.4", Image: "mariadb:11.4", Architectures: both(), MinCPU: 1, MinMemory: GiB, MinDisk: 10 * GiB, Port: 3306, Username: "dbmock", Database: "app", Scheme: "mariadb", JDBCScheme: "mariadb", DataTarget: "/var/lib/mysql", Environment: map[string]string{"MARIADB_ROOT_PASSWORD": "${DB_PASSWORD}", "MARIADB_DATABASE": "${DB_NAME}", "MARIADB_USER": "${DB_USERNAME}", "MARIADB_PASSWORD": "${DB_PASSWORD}"}, Healthcheck: []string{"CMD", "healthcheck.sh", "--connect", "--innodb_initialized"}},
		{Slug: "postgresql", Name: "PostgreSQL", NameZH: "PostgreSQL", Description: "Advanced open source relational database", Category: "relational", Tier: standard, Icon: "PG", Version: "17", Image: "postgres:17", Architectures: both(), MinCPU: 1, MinMemory: GiB, MinDisk: 10 * GiB, Port: 5432, Username: "dbmock", Database: "app", Scheme: "postgresql", JDBCScheme: "postgresql", DataTarget: "/var/lib/postgresql/data", Environment: map[string]string{"POSTGRES_USER": "${DB_USERNAME}", "POSTGRES_PASSWORD": "${DB_PASSWORD}", "POSTGRES_DB": "${DB_NAME}"}, Healthcheck: []string{"CMD-SHELL", "pg_isready -U \"$${DBMOCK_DB_USERNAME}\" -d \"$${DBMOCK_DB_NAME}\""}},
		{Slug: "redis", Name: "Redis", NameZH: "Redis", Description: "In-memory data store", Category: "key-value", Tier: standard, Icon: "RD", Version: "8.0", Image: "redis:8.0", Architectures: both(), MinCPU: .5, MinMemory: 512 * 1024 * 1024, MinDisk: 2 * GiB, Port: 6379, Username: "default", Scheme: "redis", DataTarget: "/data", Command: []string{"redis-server", "--appendonly", "yes", "--requirepass", "${DB_PASSWORD}"}, Healthcheck: []string{"CMD-SHELL", "redis-cli -a \"$${DBMOCK_DB_PASSWORD}\" ping | grep PONG"}},
		{Slug: "valkey", Name: "Valkey", NameZH: "Valkey", Description: "Open source in-memory key-value store", Category: "key-value", Tier: standard, Icon: "VK", Version: "8.1", Image: "valkey/valkey:8.1", Architectures: both(), MinCPU: .5, MinMemory: 512 * 1024 * 1024, MinDisk: 2 * GiB, Port: 6379, Username: "default", Scheme: "redis", DataTarget: "/data", Command: []string{"valkey-server", "--appendonly", "yes", "--requirepass", "${DB_PASSWORD}"}, Healthcheck: []string{"CMD-SHELL", "valkey-cli -a \"$${DBMOCK_DB_PASSWORD}\" ping | grep PONG"}},
		{Slug: "mongodb", Name: "MongoDB", NameZH: "MongoDB", Description: "Document-oriented database", Category: "document", Tier: standard, Icon: "MO", Version: "8.0", Image: "mongo:8.0", Architectures: both(), MinCPU: 1, MinMemory: GiB, MinDisk: 10 * GiB, Port: 27017, Username: "dbmock", Database: "admin", Scheme: "mongodb", DataTarget: "/data/db", Environment: map[string]string{"MONGO_INITDB_ROOT_USERNAME": "${DB_USERNAME}", "MONGO_INITDB_ROOT_PASSWORD": "${DB_PASSWORD}"}, Healthcheck: []string{"CMD-SHELL", "mongosh --quiet --username \"$${DBMOCK_DB_USERNAME}\" --password \"$${DBMOCK_DB_PASSWORD}\" --authenticationDatabase admin --eval 'db.runCommand({ping:1}).ok' | grep 1"}},
		{Slug: "clickhouse", Name: "ClickHouse", NameZH: "ClickHouse", Description: "Column-oriented analytics database", Category: "analytics", Tier: standard, Icon: "CH", Version: "25.8", Image: "clickhouse/clickhouse-server:25.8", Architectures: both(), MinCPU: 2, MinMemory: 2 * GiB, MinDisk: 20 * GiB, Port: 9000, Username: "dbmock", Database: "default", Scheme: "clickhouse", DataTarget: "/var/lib/clickhouse", Environment: map[string]string{"CLICKHOUSE_USER": "${DB_USERNAME}", "CLICKHOUSE_PASSWORD": "${DB_PASSWORD}", "CLICKHOUSE_DB": "${DB_NAME}", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT": "1"}, Healthcheck: []string{"CMD-SHELL", "clickhouse-client --user \"$${DBMOCK_DB_USERNAME}\" --password \"$${DBMOCK_DB_PASSWORD}\" --query 'SELECT 1'"}},
		{Slug: "elasticsearch", Name: "Elasticsearch", NameZH: "Elasticsearch", Description: "Search and analytics engine", Category: "search", Tier: standard, Icon: "ES", Version: "8.18.0", Image: "docker.elastic.co/elasticsearch/elasticsearch:8.18.0", Architectures: both(), MinCPU: 2, MinMemory: 4 * GiB, MinDisk: 20 * GiB, Port: 9200, Username: "elastic", Scheme: "http", DataTarget: "/usr/share/elasticsearch/data", Environment: map[string]string{"discovery.type": "single-node", "ELASTIC_PASSWORD": "${DB_PASSWORD}", "xpack.security.http.ssl.enabled": "false", "ES_JAVA_OPTS": "-Xms1g -Xmx1g"}, Healthcheck: []string{"CMD-SHELL", "curl -fsS -u \"elastic:$${DBMOCK_DB_PASSWORD}\" http://localhost:9200/_cluster/health"}, Tuning: []string{"sysctl -w vm.max_map_count=262144", "printf 'vm.max_map_count=262144\\n' >/etc/sysctl.d/99-dbmock-elasticsearch.conf"}},
		{Slug: "opensearch", Name: "OpenSearch", NameZH: "OpenSearch", Description: "Open source search and analytics suite", Category: "search", Tier: standard, Icon: "OS", Version: "2.19.1", Image: "opensearchproject/opensearch:2.19.1", Architectures: both(), MinCPU: 2, MinMemory: 4 * GiB, MinDisk: 20 * GiB, Port: 9200, Username: "admin", Scheme: "https", DataTarget: "/usr/share/opensearch/data", Environment: map[string]string{"discovery.type": "single-node", "OPENSEARCH_INITIAL_ADMIN_PASSWORD": "${DB_PASSWORD}", "DISABLE_INSTALL_DEMO_CONFIG": "false", "OPENSEARCH_JAVA_OPTS": "-Xms1g -Xmx1g"}, Healthcheck: []string{"CMD-SHELL", "curl -kfsS -u \"admin:$${DBMOCK_DB_PASSWORD}\" https://localhost:9200/_cluster/health"}, Tuning: []string{"sysctl -w vm.max_map_count=262144", "printf 'vm.max_map_count=262144\\n' >/etc/sysctl.d/99-dbmock-opensearch.conf"}},
		{Slug: "influxdb", Name: "InfluxDB", NameZH: "InfluxDB", Description: "Time-series database", Category: "time-series", Tier: standard, Icon: "IN", Version: "2.7", Image: "influxdb:2.7", Architectures: both(), MinCPU: 1, MinMemory: GiB, MinDisk: 10 * GiB, Port: 8086, Username: "dbmock", Database: "dbmock", Scheme: "http", DataTarget: "/var/lib/influxdb2", Environment: map[string]string{"DOCKER_INFLUXDB_INIT_MODE": "setup", "DOCKER_INFLUXDB_INIT_USERNAME": "${DB_USERNAME}", "DOCKER_INFLUXDB_INIT_PASSWORD": "${DB_PASSWORD}", "DOCKER_INFLUXDB_INIT_ORG": "dbmock", "DOCKER_INFLUXDB_INIT_BUCKET": "${DB_NAME}", "DOCKER_INFLUXDB_INIT_ADMIN_TOKEN": "${DB_PASSWORD}"}, Healthcheck: []string{"CMD", "influx", "ping"}},
		{Slug: "neo4j", Name: "Neo4j", NameZH: "Neo4j", Description: "Graph database", Category: "graph", Tier: standard, Icon: "N4", Version: "5.26-community", Image: "neo4j:5.26-community", Architectures: both(), MinCPU: 1, MinMemory: 2 * GiB, MinDisk: 10 * GiB, Port: 7687, Username: "neo4j", Scheme: "bolt", DataTarget: "/data", Environment: map[string]string{"NEO4J_AUTH": "${DB_USERNAME}/${DB_PASSWORD}"}, Healthcheck: []string{"CMD-SHELL", "wget -qO- http://localhost:7474 >/dev/null"}},
		{Slug: "cassandra", Name: "Apache Cassandra", NameZH: "Apache Cassandra", Description: "Wide-column distributed database in single-node mode", Category: "wide-column", Tier: standard, Icon: "CA", Version: "5.0", Image: "cassandra:5.0", Architectures: both(), MinCPU: 2, MinMemory: 4 * GiB, MinDisk: 20 * GiB, Port: 9042, Username: "cassandra", Scheme: "cassandra", DataTarget: "/var/lib/cassandra", Environment: map[string]string{"CASSANDRA_CLUSTER_NAME": "DB Mock", "CASSANDRA_ENDPOINT_SNITCH": "GossipingPropertyFileSnitch"}, Healthcheck: []string{"CMD-SHELL", "cqlsh -e 'DESCRIBE CLUSTER'"}},
		{Slug: "sqlserver", Name: "Microsoft SQL Server", NameZH: "SQL Server", Description: "Microsoft SQL Server Developer container", Category: "relational", Tier: standard, Icon: "MS", Version: "2022", Image: "mcr.microsoft.com/mssql/server:2022-latest", Architectures: []string{"amd64"}, MinCPU: 2, MinMemory: 4 * GiB, MinDisk: 20 * GiB, Port: 1433, Username: "sa", Database: "master", Scheme: "sqlserver", JDBCScheme: "sqlserver", DataTarget: "/var/opt/mssql", Environment: map[string]string{"ACCEPT_EULA": "Y", "MSSQL_PID": "Developer", "MSSQL_SA_PASSWORD": "${DB_PASSWORD}"}, Healthcheck: []string{"CMD-SHELL", "/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P \"$${DBMOCK_DB_PASSWORD}\" -C -Q 'SELECT 1'"}},
		{Slug: "oracle", Name: "Oracle Database Free", NameZH: "Oracle Database Free", Description: "Oracle Database Free container", Category: "relational", Tier: standard, Icon: "OR", Version: "23", Image: "gvenzl/oracle-free:23-slim", Architectures: both(), MinCPU: 4, MinMemory: 8 * GiB, MinDisk: 30 * GiB, Port: 1521, Username: "dbmock", Database: "FREEPDB1", Scheme: "oracle", JDBCScheme: "oracle:thin", DataTarget: "/opt/oracle/oradata", Environment: map[string]string{"ORACLE_PASSWORD": "${DB_PASSWORD}", "APP_USER": "${DB_USERNAME}", "APP_USER_PASSWORD": "${DB_PASSWORD}"}, Healthcheck: []string{"CMD", "healthcheck.sh"}},
		{Slug: "opengauss", Name: "openGauss", NameZH: "openGauss", Description: "openGauss community relational database", Category: "relational", Tier: standard, Icon: "OG", Version: "6.0.0", Image: "opengauss/opengauss:6.0.0", Architectures: both(), MinCPU: 2, MinMemory: 2 * GiB, MinDisk: 10 * GiB, Port: 5432, Username: "gaussdb", Database: "postgres", Scheme: "postgresql", JDBCScheme: "postgresql", DataTarget: "/var/lib/opengauss/data", Environment: map[string]string{"GS_PASSWORD": "${DB_PASSWORD}"}, Healthcheck: []string{"CMD-SHELL", "gsql -d postgres -U gaussdb -W \"$${DBMOCK_DB_PASSWORD}\" -c 'select 1'"}, Privileged: true},
		{Slug: "tidb", Name: "TiDB", NameZH: "TiDB", Description: "TiDB single-host development mode", Category: "distributed-sql", Tier: experimental, Icon: "TI", Version: "8.5.3", Image: "pingcap/tidb:v8.5.3", Architectures: []string{"amd64"}, MinCPU: 2, MinMemory: 4 * GiB, MinDisk: 20 * GiB, Port: 4000, Username: "root", Database: "test", Scheme: "mysql", JDBCScheme: "mysql", DataTarget: "/var/lib/tidb", Command: []string{"--store=unistore", "--path=/var/lib/tidb", "--host=0.0.0.0"}, Healthcheck: []string{"CMD-SHELL", "wget -qO- http://localhost:10080/status | grep -q 'connections'"}},
		{Slug: "oceanbase", Name: "OceanBase CE", NameZH: "OceanBase 社区版", Description: "OceanBase CE mini single-host mode", Category: "distributed-sql", Tier: experimental, Icon: "OB", Version: "4.3.5-lts", Image: "oceanbase/oceanbase-ce:4.3.5-lts", Architectures: []string{"amd64"}, MinCPU: 4, MinMemory: 8 * GiB, MinDisk: 30 * GiB, Port: 2881, Username: "root", Database: "test", Scheme: "mysql", JDBCScheme: "mysql", DataTarget: "/root/ob", Environment: map[string]string{"MODE": "mini", "OB_ROOT_PASSWORD": "${DB_PASSWORD}"}, Healthcheck: []string{"CMD-SHELL", "obclient -h127.0.0.1 -P2881 -uroot -p\"$${DBMOCK_DB_PASSWORD}\" -e 'select 1'"}},
		{Slug: "starrocks", Name: "StarRocks", NameZH: "StarRocks", Description: "StarRocks all-in-one development container", Category: "analytics", Tier: experimental, Icon: "SR", Version: "3.4", Image: "starrocks/allin1-ubuntu:3.4-latest", Architectures: []string{"amd64"}, MinCPU: 4, MinMemory: 8 * GiB, MinDisk: 30 * GiB, Port: 9030, Username: "root", Database: "default_catalog", Scheme: "mysql", JDBCScheme: "mysql", DataTarget: "/data/deploy", Healthcheck: []string{"CMD-SHELL", "mysql -h127.0.0.1 -P9030 -uroot -e 'select 1'"}},
		{Slug: "doris", Name: "Apache Doris", NameZH: "Apache Doris", Description: "Apache Doris FE and BE on one host", Category: "analytics", Tier: experimental, Icon: "DO", Version: "2.1.11", Image: "apache/doris:fe-2.1.11", Architectures: []string{"amd64"}, MinCPU: 4, MinMemory: 8 * GiB, MinDisk: 30 * GiB, Port: 9030, Username: "root", Database: "information_schema", Scheme: "mysql", JDBCScheme: "mysql", Compose: dorisCompose(), Tuning: []string{"sysctl -w vm.max_map_count=2000000", "printf 'vm.max_map_count=2000000\\n' >/etc/sysctl.d/99-dbmock-doris.conf"}},
	}
}

func both() []string { return []string{"amd64", "arm64"} }
func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func singleServiceCompose(d Definition) string {
	privileged := ""
	if d.Privileged {
		privileged = "    privileged: true\n"
	}
	data := ""
	if d.DataTarget != "" {
		data = "    volumes:\n      - \"{{ .DataPath }}:" + d.DataTarget + "\"\n"
	}
	environment := "    environment:\n" +
		"      DBMOCK_DB_USERNAME: \"${DB_USERNAME}\"\n" +
		"      DBMOCK_DB_PASSWORD: \"${DB_PASSWORD}\"\n" +
		"      DBMOCK_DB_NAME: \"${DB_NAME}\"\n"
	for key, value := range d.Environment {
		environment += fmt.Sprintf("      %s: %q\n", key, value)
	}
	environment += "{{ .ExtraEnvironment }}"
	command := ""
	if len(d.Command) > 0 {
		encoded, _ := json.Marshal(d.Command)
		command = "    command: " + string(encoded) + "\n"
	}
	health := ""
	if len(d.Healthcheck) > 0 {
		encoded, _ := json.Marshal(d.Healthcheck)
		health = "    healthcheck:\n      test: " + string(encoded) + "\n      interval: 10s\n      timeout: 5s\n      retries: 30\n      start_period: 20s\n"
	}
	return `services:
  database:
    image: "{{ .Image }}"
    container_name: "dbmock-{{ .ShortID }}-database"
    restart: "{{ .RestartPolicy }}"
    labels:
      dbmock.instance: "{{ .InstanceID }}"
      dbmock.template: "{{ .TemplateSlug }}"
      dbmock.project: "{{ .ProjectLabel }}"
    ports:
      - "{{ .BindAddress }}:{{ .HostPort }}:` + fmt.Sprintf("%d", d.Port) + `"
` + privileged + environment + command + data + `    cpus: "{{ .CPU }}"
    mem_limit: "{{ .MemoryBytes }}"
    logging:
      driver: json-file
      options:
        max-size: "100m"
        max-file: "5"
` + health
}

func dorisCompose() string {
	return `services:
  fe:
    image: "apache/doris:fe-2.1.11"
    container_name: "dbmock-{{ .ShortID }}-fe"
    restart: "{{ .RestartPolicy }}"
    hostname: fe
    environment:
      FE_SERVERS: "fe1:172.28.0.2:9010"
      FE_ID: "1"
{{ .ExtraEnvironment }}    ports:
      - "{{ .BindAddress }}:{{ .HostPort }}:9030"
    volumes:
      - "{{ .DataPath }}/fe:/opt/apache-doris/fe/doris-meta"
    labels: { dbmock.instance: "{{ .InstanceID }}", dbmock.template: "doris" }
    networks:
      doris_net: { ipv4_address: 172.28.0.2 }
    cpus: "{{ .CPU }}"
    mem_limit: "{{ .MemoryBytes }}"
    logging: { driver: json-file, options: { max-size: "100m", max-file: "5" } }
  be:
    image: "apache/doris:be-2.1.11"
    container_name: "dbmock-{{ .ShortID }}-be"
    restart: "{{ .RestartPolicy }}"
    hostname: be
    environment:
      FE_SERVERS: "fe1:172.28.0.2:9010"
      BE_ADDR: "172.28.0.3:9050"
    volumes:
      - "{{ .DataPath }}/be:/opt/apache-doris/be/storage"
    labels: { dbmock.instance: "{{ .InstanceID }}", dbmock.template: "doris" }
    depends_on: [fe]
    networks:
      doris_net: { ipv4_address: 172.28.0.3 }
    cpus: "{{ .CPU }}"
    mem_limit: "{{ .MemoryBytes }}"
    logging: { driver: json-file, options: { max-size: "100m", max-file: "5" } }
networks:
  doris_net:
    ipam:
      config: [{ subnet: 172.28.0.0/24 }]
`
}
