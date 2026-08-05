import type { ConfigProviderProps, ThemeConfig } from 'antd'

export const appButtonConfig = {
  autoInsertSpace: false,
} satisfies NonNullable<ConfigProviderProps['button']>

export const appTheme = {
  token: {
    colorPrimary: '#2563eb',
    colorPrimaryHover: '#1d4ed8',
    colorPrimaryActive: '#1e40af',
    controlHeight: 36,
    controlHeightSM: 30,
    controlHeightLG: 42,
    borderRadius: 10,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  components: {
    Button: {
      borderRadius: 8,
      borderRadiusSM: 7,
      borderRadiusLG: 9,
      fontWeight: 600,
      iconGap: 6,
      paddingInline: 14,
      paddingInlineSM: 10,
      paddingInlineLG: 18,
      contentFontSize: 14,
      contentFontSizeSM: 13,
      contentFontSizeLG: 14,
      onlyIconSize: 15,
      onlyIconSizeSM: 14,
      onlyIconSizeLG: 16,
      defaultColor: '#344054',
      defaultBorderColor: '#d0d5dd',
      defaultHoverBg: '#f8fafc',
      defaultHoverColor: '#1d4ed8',
      defaultHoverBorderColor: '#84adf7',
      defaultActiveBg: '#eff6ff',
      defaultActiveColor: '#1e40af',
      defaultActiveBorderColor: '#2563eb',
      defaultShadow: '0 1px 2px rgb(16 24 40 / 5%)',
      primaryShadow: '0 1px 2px rgb(37 99 235 / 18%)',
      dangerShadow: '0 1px 2px rgb(217 45 32 / 14%)',
      textTextColor: '#475467',
      textTextHoverColor: '#1d4ed8',
      textTextActiveColor: '#1e40af',
      textHoverBg: '#f2f4f7',
      linkHoverBg: 'transparent',
    },
    Layout: { headerBg: '#fff', siderBg: '#fff' },
    Menu: { itemBorderRadius: 8 },
  },
} satisfies ThemeConfig
