import { render, screen, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { PageHeader, PageHeaderTargetProvider, StatusTag } from './Common'

describe('StatusTag', () => {
  it('renders a localized status', async () => {
    await i18n.changeLanguage('en-US')
    render(<I18nextProvider i18n={i18n}><StatusTag value="running" /></I18nextProvider>)
    expect(screen.getByText('Running')).toBeInTheDocument()
  })
})

describe('PageHeader', () => {
  it('renders the heading in the shared header target', () => {
    const target = document.createElement('div')
    document.body.append(target)
    render(<PageHeaderTargetProvider target={target}><PageHeader title="Instances" description="Managed databases" /></PageHeaderTargetProvider>)
    expect(within(target).getByRole('heading', { name: 'Instances' })).toHaveAttribute('tabindex', '-1')
    expect(within(target).getByText('Managed databases')).toBeInTheDocument()
    target.remove()
  })
})
