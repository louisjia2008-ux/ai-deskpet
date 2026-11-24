import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { VoiceStatus } from '../../shared/voice';
import { VoiceSettings } from './VoiceSettings';

afterEach(cleanup);

it('turns voice on, chooses the folder through the host, says what is missing and tests only when ready', async () => {
  let status: VoiceStatus = { enabled: false, runtimeDir: null, state: 'off', problem: 'folder' };
  const api = {
    getVoice: vi.fn(async () => status),
    setVoiceEnabled: vi.fn(async (enabled: boolean) => { status = { ...status, enabled, state: 'missing' }; return status; }),
    chooseVoiceFolder: vi.fn(async () => { status = { ...status, runtimeDir: '/voice', state: 'idle', problem: null }; return status; }),
    testVoice: vi.fn(async () => true), stopVoice: vi.fn(async () => undefined),
  };
  Object.assign(window, { deskpet: { character: api } });
  render(<VoiceSettings locale="zh-CN" />);
  // Off: only the switch is offered; setup details wait behind a fold.
  const toggle = await screen.findByRole('checkbox', { name: '朗读她的回复' });
  expect(screen.queryByRole('button', { name: '试听' })).toBeNull();
  fireEvent.click(toggle);
  expect(await screen.findByText('文件夹还没准备好。 请选择语音文件夹。')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
  expect(await screen.findByText('准备好了，下次回复时加载模型。')).toBeVisible();
  // Ready: the folder moves into the fold.
  expect(screen.getByDisplayValue('/voice')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '试听' }));
  await waitFor(() => expect(api.testVoice).toHaveBeenCalledOnce());
});
