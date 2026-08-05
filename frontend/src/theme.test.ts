import { describe, expect, it } from 'vitest'
import { appButtonConfig, appTheme } from './theme'

describe('application button system', () => {
  it('uses one control scale and does not insert spaces into Chinese labels', () => {
    expect(appButtonConfig.autoInsertSpace).toBe(false)
    expect(appTheme.token).toMatchObject({
      controlHeight: 36,
      controlHeightSM: 30,
      controlHeightLG: 42,
    })
  })

  it('uses the shared shape, weight, spacing, and interaction colors', () => {
    expect(appTheme.components?.Button).toMatchObject({
      borderRadius: 8,
      borderRadiusSM: 7,
      borderRadiusLG: 9,
      fontWeight: 600,
      iconGap: 6,
      defaultColor: '#344054',
      defaultBorderColor: '#d0d5dd',
      defaultHoverColor: '#1d4ed8',
      defaultActiveColor: '#1e40af',
      textHoverBg: '#f2f4f7',
    })
  })
})
