import type { IconType } from 'react-icons'
import { DiDatabase, DiMsqlServer } from 'react-icons/di'
import { LuKeyRound, LuLayers3, LuWaves } from 'react-icons/lu'
import {
  SiApachecassandra,
  SiApachedoris,
  SiClickhouse,
  SiElasticsearch,
  SiInfluxdb,
  SiMariadb,
  SiMongodb,
  SiMysql,
  SiNeo4J,
  SiOpensearch,
  SiPostgresql,
  SiRedis,
  SiTidb,
} from 'react-icons/si'
import { VscDatabase } from 'react-icons/vsc'

interface DatabaseIconDefinition {
  icon: IconType
  color: string
  background: string
}

const databaseIcons: Record<string, DatabaseIconDefinition> = {
  mysql: { icon: SiMysql, color: '#4479a1', background: '#edf6fb' },
  mariadb: { icon: SiMariadb, color: '#003545', background: '#eaf4f3' },
  postgresql: { icon: SiPostgresql, color: '#4169e1', background: '#eef2ff' },
  redis: { icon: SiRedis, color: '#dc382d', background: '#fff0ee' },
  valkey: { icon: LuKeyRound, color: '#6b8e23', background: '#f3f8e8' },
  mongodb: { icon: SiMongodb, color: '#47a248', background: '#eef8ee' },
  clickhouse: { icon: SiClickhouse, color: '#202124', background: '#fff7bf' },
  elasticsearch: { icon: SiElasticsearch, color: '#005571', background: '#eaf7fa' },
  opensearch: { icon: SiOpensearch, color: '#005eb8', background: '#edf5ff' },
  influxdb: { icon: SiInfluxdb, color: '#22adf6', background: '#eaf8ff' },
  neo4j: { icon: SiNeo4J, color: '#4581c3', background: '#edf5ff' },
  cassandra: { icon: SiApachecassandra, color: '#1287b1', background: '#eaf8fc' },
  sqlserver: { icon: DiMsqlServer, color: '#cc2927', background: '#fff0ef' },
  oracle: { icon: DiDatabase, color: '#f80000', background: '#fff0ef' },
  opengauss: { icon: VscDatabase, color: '#2f70c0', background: '#eef5ff' },
  tidb: { icon: SiTidb, color: '#e6002d', background: '#fff0f3' },
  oceanbase: { icon: LuWaves, color: '#1677ff', background: '#edf5ff' },
  starrocks: { icon: LuLayers3, color: '#6c4ce3', background: '#f2efff' },
  doris: { icon: SiApachedoris, color: '#5c43d2', background: '#f2efff' },
}

const fallbackIcon: DatabaseIconDefinition = { icon: VscDatabase, color: '#2563eb', background: '#eef4ff' }

export function DatabaseIcon({ slug, name, size = 'large' }: { slug: string; name: string; size?: 'small' | 'large' }) {
  const definition = databaseIcons[slug.toLowerCase()] ?? fallbackIcon
  const Icon = definition.icon
  return <span
    className={`database-icon database-icon-${size}`}
    style={{ color: definition.color, background: definition.background }}
    role="img"
    aria-label={name}
    title={name}
  ><Icon aria-hidden /></span>
}
