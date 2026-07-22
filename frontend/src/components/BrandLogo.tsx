export function BrandLogo({ small = false }: { small?: boolean }) {
  return <img className={small ? 'brand-logo small' : 'brand-logo'} src="/dbmock-logo.png" alt="" aria-hidden="true" draggable={false} />
}
