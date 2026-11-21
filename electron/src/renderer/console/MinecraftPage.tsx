import type { JSX } from 'react';
import type { ResolvedLocale } from '../../shared';
import { MinecraftCompanionPanel } from './MinecraftCompanionPanel';

interface MinecraftPageProps {
  locale: ResolvedLocale;
  t: (key: string) => string;
  onDedicatedSettings?: () => void;
}

export const MinecraftPage = ({ locale, t, onDedicatedSettings }: MinecraftPageProps): JSX.Element => (
  <section className="minecraft-page">
    <header className="page-header">
      <span>{t('nav.minecraft')}</span>
      <h1>{t('minecraft.title')}</h1>
      <p>{t('minecraft.description')}</p>
    </header>
    <MinecraftCompanionPanel locale={locale} {...(onDedicatedSettings ? { onDedicatedSettings } : {})} />
  </section>
);
