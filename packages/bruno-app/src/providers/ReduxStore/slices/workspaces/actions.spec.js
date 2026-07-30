jest.mock('@usebruno/schema', () => ({
  collectionSchema: { validate: () => Promise.resolve() },
  environmentSchema: { validate: () => Promise.resolve() },
  itemSchema: { validate: () => Promise.resolve() }
}));

jest.mock('react-hot-toast', () => ({
  success: jest.fn(),
  error: jest.fn(),
  dismiss: jest.fn()
}));

jest.mock('../collections/actions', () => ({
  createCollection: jest.fn(() => () => Promise.resolve()),
  openMultipleCollections: jest.fn(() => () => Promise.resolve({ opened: [], failed: [], invalid: [] })),
  openScratchCollectionEvent: jest.fn(() => () => Promise.resolve()),
  mountCollection: jest.fn(() => () => Promise.resolve()),
  hydrateCollectionWithUiStateSnapshot: jest.fn(() => () => Promise.resolve())
}));

import os from 'os';
import path from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import toast from 'react-hot-toast';
import { configureStore } from '@reduxjs/toolkit';
import workspacesReducer, { updateWorkspace } from './index';
import collectionsReducer from '../collections';
import chatReducer, { openAiSidebar } from '../chat';
import appReducer from '../app';
import tabsReducer from '../tabs';
import globalEnvironmentsReducer from '../global-environments';

const WS_A = 'workspace-a';
const WS_B = 'workspace-b';
const SCRATCH_A = 'scratch-a';
const SCRATCH_B = 'scratch-b';

const makeScratchCollection = (uid) => ({
  uid,
  pathname: path.join(os.tmpdir(), uid),
  name: 'Scratch',
  items: [],
  brunoConfig: { version: '1', name: 'Scratch', type: 'collection' },
  mountStatus: 'mounted'
});

const makeWorkspace = (uid, scratchUid) => ({
  uid,
  name: uid,
  pathname: null,
  collections: [],
  scratchCollectionUid: scratchUid
});

const mockIpcInvoke = (channel) => {
  if (channel === 'renderer:snapshot:get') {
    return Promise.resolve(null);
  }
  if (channel === 'renderer:get-global-environments') {
    return Promise.resolve({ globalEnvironments: [], activeGlobalEnvironmentUid: null });
  }
  return Promise.resolve(null);
};

const createStore = ({ activeWorkspaceUid = WS_A } = {}) => {
  const preloadedState = {
    workspaces: {
      activeWorkspaceUid,
      workspaces: [makeWorkspace(WS_A, SCRATCH_A), makeWorkspace(WS_B, SCRATCH_B)]
    },
    collections: {
      collections: [makeScratchCollection(SCRATCH_A), makeScratchCollection(SCRATCH_B)],
      collectionSortOrder: 'default',
      activeConnections: [],
      tempDirectories: {},
      saveTransientRequestModals: []
    },
    chat: { isOpen: false, chats: {} },
    app: {
      snapshotReady: true,
      snapshotHydration: {
        workspaceUid: null,
        pendingCollectionPathnames: [],
        activeCollectionPathname: null,
        startedAt: null
      },
      preferences: { cache: { file: { enabled: false } } }
    },
    tabs: { tabs: [], activeTabUid: null, recentlyClosedTabs: [] },
    globalEnvironments: {
      globalEnvironments: [],
      activeGlobalEnvironmentUid: null,
      globalEnvironmentDraft: null,
      _scriptGlobalEnvBaseline: null
    }
  };

  return configureStore({
    reducer: {
      workspaces: workspacesReducer,
      collections: collectionsReducer,
      chat: chatReducer,
      app: appReducer,
      tabs: tabsReducer,
      globalEnvironments: globalEnvironmentsReducer
    },
    preloadedState
  });
};

describe('switchWorkspace', () => {
  let switchWorkspace;

  const WS_B_PATH = path.join(os.tmpdir(), 'ws-b');
  const FAILED_A = path.join(os.tmpdir(), 'failed-a');
  const FAILED_B = path.join(os.tmpdir(), 'failed-b');

  beforeAll(async () => {
    window.ipcRenderer = { invoke: jest.fn(mockIpcInvoke) };
    ({ switchWorkspace } = await import('./actions'));
  });

  beforeEach(() => {
    toast.error.mockClear();
    toast.dismiss.mockClear();
    window.ipcRenderer.invoke = jest.fn(mockIpcInvoke);
  });

  it('closes the AI sidebar when switching workspaces', async () => {
    const store = createStore();
    store.dispatch(openAiSidebar());
    expect(store.getState().chat.isOpen).toBe(true);

    await store.dispatch(switchWorkspace(WS_B));

    expect(store.getState().chat.isOpen).toBe(false);
    expect(store.getState().workspaces.activeWorkspaceUid).toBe(WS_B);
  });

  it('toasts when a single collection is missing or failed to open', async () => {
    const store = createStore();
    store.dispatch(updateWorkspace({ uid: WS_B, pathname: WS_B_PATH }));
    window.ipcRenderer.invoke = jest.fn((channel) => {
      if (channel === 'renderer:load-workspace-collections') {
        return Promise.resolve([
          { name: 'Failed', path: FAILED_A, failedToOpen: true, failureReason: 'not-found' }
        ]);
      }
      return mockIpcInvoke(channel);
    });

    await store.dispatch(switchWorkspace(WS_B));

    expect(toast.error).toHaveBeenCalledWith(`Collection is missing or failed to open: ${FAILED_A}`);
  });

  it('toasts Some with a Workspace Overview link when multiple collections fail', async () => {
    const store = createStore();
    store.dispatch(updateWorkspace({ uid: WS_B, pathname: WS_B_PATH }));
    window.ipcRenderer.invoke = jest.fn((channel) => {
      if (channel === 'renderer:load-workspace-collections') {
        return Promise.resolve([
          { name: 'Failed A', path: FAILED_A, failedToOpen: true, failureReason: 'not-found' },
          { name: 'Failed B', path: FAILED_B, failedToOpen: true, failureReason: 'invalid' }
        ]);
      }
      return mockIpcInvoke(channel);
    });

    await store.dispatch(switchWorkspace(WS_B));

    expect(toast.error).toHaveBeenCalledTimes(1);
    const renderToast = toast.error.mock.calls[0][0];
    expect(typeof renderToast).toBe('function');

    render(renderToast({ id: 'toast-1' }));
    expect(screen.getByText(/Some collections are missing or failed to open/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View in Workspace Overview' }));

    expect(toast.dismiss).toHaveBeenCalledWith('toast-1');
    expect(store.getState().tabs.activeTabUid).toBe(`${SCRATCH_B}-overview`);
  });
});

describe('workspaceConfigUpdatedEvent', () => {
  let workspaceConfigUpdatedEvent;
  let openMultipleCollections;

  const WS_A_PATH = path.join(os.tmpdir(), 'ws-a');
  const GOOD_COLL = path.join(os.tmpdir(), 'good-coll');
  const FAILED_COLL = path.join(os.tmpdir(), 'failed-coll');

  beforeAll(async () => {
    ({ openMultipleCollections } = await import('../collections/actions'));
    ({ workspaceConfigUpdatedEvent } = await import('./actions'));
  });

  beforeEach(() => {
    openMultipleCollections.mockClear();
    // actions.js captures `const { ipcRenderer } = window` at import time, so mutate
    // the existing object's `invoke` rather than reassigning window.ipcRenderer.
    window.ipcRenderer.invoke = jest.fn((channel) => {
      if (channel === 'renderer:load-workspace-collections') {
        return Promise.resolve([
          { name: 'Good', path: GOOD_COLL },
          { name: 'Failed', path: FAILED_COLL, failedToOpen: true, failureReason: 'invalid' }
        ]);
      }
      return mockIpcInvoke(channel);
    });
  });

  it('does not re-attempt to open failed-to-open collections on a config update', async () => {
    const store = createStore();
    store.dispatch(updateWorkspace({ uid: WS_A, pathname: WS_A_PATH }));

    await store.dispatch(workspaceConfigUpdatedEvent(WS_A_PATH, WS_A, { collections: [], docs: '' }));

    expect(openMultipleCollections).toHaveBeenCalledTimes(1);
    const attemptedPaths = openMultipleCollections.mock.calls[0][0];
    expect(attemptedPaths).toContain(GOOD_COLL);
    expect(attemptedPaths).not.toContain(FAILED_COLL);
  });
});
