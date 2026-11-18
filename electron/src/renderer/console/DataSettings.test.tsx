import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataSettings } from './DataSettings';
import { messages } from '../../shared';
import type { MessageKey } from '../../shared';

afterEach(cleanup);
const setup = () => {
  const backup = { create: vi.fn(async () => ({ path: '/tmp/fixture.deskpet-backup', files: 5, bytes: 512 })), restore: vi.fn(), restart: vi.fn() };
  Object.defineProperty(window, 'deskpet', { value: { backup }, configurable: true });
  render(<DataSettings directory="/fixed/DeskPet" t={(key) => messages.en[key as MessageKey] ?? key} />);
  return backup;
};
it('requires confirmation for export and clears both password fields after completion', async () => {
  const backup = setup();
  const create = screen.getByRole('button', { name: 'Create encrypted backup' });
  fireEvent.change(screen.getByLabelText('Backup password'), { target: { value: 'fixture-password' } });
  expect(create).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Confirm password for a new backup'), { target: { value: 'fixture-password' } });
  fireEvent.click(create);
  await screen.findByText('Encrypted backup saved');
  expect(backup.create).toHaveBeenCalledWith('fixture-password');
  expect(screen.getByLabelText('Backup password')).toHaveValue('');
  expect(screen.getByLabelText('Confirm password for a new backup')).toHaveValue('');
});
it('shows a failed restore without reporting success', async () => {
  const backup = setup(); backup.restore.mockRejectedValue(new Error('backup.error.authentication'));
  fireEvent.change(screen.getByLabelText('Backup password'), { target: { value: 'fixture-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Incorrect password'));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
