import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig } from '../../shared';
import type { ModelRouting } from '../../shared/model-routing';
import { ModelRoutingSettings } from './ModelRoutingSettings';

afterEach(cleanup);
const legacy: ModelRouting = {enabled:false,localProviderId:null,cloudProviderId:null};
const providers: ProviderConfig[] = [1,2,3,4,5].map<ProviderConfig>(index => ({
  id:`00000000-0000-4000-8000-00000000000${index}`, name:`Provider ${index}`, model:`model-${index}`,
  kind:'ollama', baseUrl:'http://127.0.0.1:11434', enabled:index !== 5, supportsTools:true,
  localExecutionConfirmed:true, secretState:'missing',
}));
const setup = async (routing: ModelRouting = legacy) => {
  const getRouting = vi.fn(async () => structuredClone(routing));
  const setRouting = vi.fn<DeskPetApi['providers']['setRouting']>(async value => structuredClone(value));
  Object.defineProperty(window,'deskpet',{configurable:true,value:{providers:{getRouting,setRouting}} as unknown as DeskPetApi});
  render(<ModelRoutingSettings providers={providers} locale="en" />);
  fireEvent.click(await screen.findByText('Model routing and fallback'));
  return {getRouting,setRouting};
};

it('loads a legacy configuration with fallback disabled and saves only on explicit submission', async () => {
  const api = await setup();
  expect(screen.getByRole('checkbox',{name:'Try fallback models when a request fails before its first response'})).not.toBeChecked();
  expect(screen.getByRole('checkbox',{name:'Prefer a local model for desktop chat'})).not.toBeChecked();
  expect(api.setRouting).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Save routing'}));
  await waitFor(() => expect(api.setRouting).toHaveBeenCalledExactlyOnceWith({...legacy,fallback:{enabled:false,providerIds:[]}}));
});

it('edits a bounded unique fallback order without enabling local-first routing', async () => {
  const api = await setup();
  const selector = screen.getByRole('combobox',{name:'Add fallback model'});
  expect(within(selector).queryByRole('option',{name:/Provider 5/u})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox',{name:'Try fallback models when a request fails before its first response'}));
  expect(screen.getByRole('button',{name:'Save routing'})).toBeDisabled();
  for (const provider of providers.slice(0,3)) {
    fireEvent.change(selector,{target:{value:provider.id}});
    fireEvent.click(screen.getByRole('button',{name:'Add to fallback order'}));
  }
  expect(screen.getByRole('button',{name:'Add to fallback order'})).toBeDisabled();
  expect(within(selector).queryByRole('option',{name:/Provider 1/u})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Move up Provider 3 · model-3'}));
  fireEvent.click(screen.getByRole('button',{name:'Remove Provider 1 · model-1'}));
  const rows = within(screen.getByRole('list',{name:'Fallback model order'})).getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('Provider 3 · model-3');
  expect(rows[1]).toHaveTextContent('Provider 2 · model-2');
  expect(api.setRouting).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Save routing'}));
  await waitFor(() => expect(api.setRouting).toHaveBeenCalledExactlyOnceWith({...legacy,fallback:{enabled:true,providerIds:[providers[2]!.id,providers[1]!.id]}}));
});

it('keeps unavailable stored targets visible for removal and sanitizes save failures', async () => {
  const removedId = '00000000-0000-4000-8000-000000000099';
  const api = await setup({...legacy,fallback:{enabled:true,providerIds:[removedId,providers[0]!.id]}});
  expect(screen.getByText('Removed provider')).toBeInTheDocument();
  expect(screen.getByText('Unavailable; remove or enable it')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Remove Removed provider'}));
  api.setRouting.mockRejectedValueOnce(new Error('private upstream content'));
  fireEvent.click(screen.getByRole('button',{name:'Save routing'}));
  await screen.findByText('Could not save. Check the enabled providers.');
  expect(screen.queryByText('private upstream content')).not.toBeInTheDocument();
  expect(within(screen.getByRole('list',{name:'Fallback model order'})).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText(/Local requests and private conversations never switch to the cloud automatically/u)).toBeInTheDocument();
});
