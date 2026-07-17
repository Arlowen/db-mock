import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { StatusTag } from './Common'

describe('StatusTag', () => {
  it('renders a localized status', async () => {
    await i18n.changeLanguage('en-US')
    render(<I18nextProvider i18n={i18n}><StatusTag value="running" /></I18nextProvider>)
    expect(screen.getByText('Running')).toBeInTheDocument()
  })
})
