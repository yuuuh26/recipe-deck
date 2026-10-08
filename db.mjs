import {changedCharacters} from './cloud-policy.mjs';
const NAME = 'recipe-deck';
const VERSION = 2;
const listeners = new Set();
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('recipe-deck-changes') : null;
channel?.addEventListener('message', () => listeners.forEach(fn => fn()));
export const onDataChanged = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const announce = () => { listeners.forEach(fn => fn()); channel?.postMessage('changed'); };
export const defaultCloudState = () => ({key: 'main', revision: 0, acknowledgedRevision: 0, deviceId: crypto.randomUUID(), attempt: null, lastSentAt: null, textChanges: 0, acknowledgedTextChanges: 0, immediateRevision: 0, lastEditAt: null});
let database;

export async function openDatabase() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('tags')) db.createObjectStore('tags', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('cloud')) db.createObjectStore('cloud', {keyPath: 'key'});
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath: 'key'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('別のタブでアプリを閉じてから再試行してください'));
  });
  database.onversionchange = () => { database.close(); database = null; };
  return database;
}

export async function all(store) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const request = tx.objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function write(stores, callback, {expectedRevision, recovery, recipe} = {}) {
  const db = await openDatabase();
  const changed = stores.includes('recipes') || stores.includes('tags');
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...new Set([...stores, ...(changed ? ['cloud'] : [])])], 'readwrite');
    tx.oncomplete = () => { if (changed) announce(); resolve(); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました。もう一度確認してください'));
    const apply = () => { try { callback(tx); } catch (error) { tx.abort(); reject(error); } };
    if (!changed) { apply(); return; }
    const cloud = tx.objectStore('cloud'), request = cloud.get('main');
    request.onsuccess = () => {
      const meta = request.result || defaultCloudState();
      if (expectedRevision !== undefined && meta.revision !== expectedRevision) { tx.abort(); return; }
      if (recovery) {
        cloud.put({key: 'recovery', data: recovery});
        meta.attempt = null;
      }
      const recordChange = previous => {
        // Existing unsent data from v1.3.0 must retain its original eligibility.
        if (meta.textChanges === undefined && meta.revision > meta.acknowledgedRevision) meta.immediateRevision = meta.revision;
        meta.textChanges ??= 0; meta.acknowledgedTextChanges ??= 0;
        meta.revision++; meta.lastEditAt = Date.now();
        if (recipe) {
          meta.textChanges += changedCharacters(previous?.recipeText, recipe.recipeText) + changedCharacters(previous?.notes, recipe.notes);
          if ((previous?.rating ?? null) !== recipe.rating || JSON.stringify(previous?.tagIds ?? []) !== JSON.stringify(recipe.tagIds) || (previous?.genre || '') !== (recipe.genre || '')) meta.immediateRevision = meta.revision;
        } else meta.immediateRevision = meta.revision;
        cloud.put(meta); apply();
      };
      if (recipe) {
        const previous = tx.objectStore('recipes').get(recipe.id);
        previous.onsuccess = () => recordChange(previous.result);
      } else recordChange();
    };
  });
}

export const putRecipe = (recipe, settings) => write(settings ? ['recipes', 'settings'] : ['recipes'], tx => {
  tx.objectStore('recipes').put(recipe);
  if (settings) tx.objectStore('settings').put({key: 'main', ...settings});
}, {recipe});
export const putSettings = settings => write(['settings'], tx => tx.objectStore('settings').put({key: 'main', ...settings}));
// Genre management is content: capture settings and recipe changes atomically,
// and schedule a cloud backup even when no recipe text changed.
export const putGenreSettings = settings => write(['recipes', 'settings'], tx => tx.objectStore('settings').put({key: 'main', ...settings}));
export const removeGenreEverywhere = (genre, recipes, settings, updatedAt) => write(['recipes', 'settings'], tx => {
  tx.objectStore('settings').put({key: 'main', ...settings});
  for (const recipe of recipes) if (recipe.genre === genre) tx.objectStore('recipes').put({...recipe, genre: '', updatedAt});
});
export const removeRecipe = id => write(['recipes'], tx => tx.objectStore('recipes').delete(id));
export const putTag = tag => write(['tags'], tx => tx.objectStore('tags').put(tag));
export const removeTagEverywhere = (id, recipes, updatedAt) => write(['tags', 'recipes'], tx => {
  tx.objectStore('tags').delete(id);
  for (const recipe of recipes) if (recipe.tagIds.includes(id)) {
    tx.objectStore('recipes').put({...recipe, tagIds: recipe.tagIds.filter(item => item !== id), updatedAt});
  }
});
export const replaceAll = (data, options) => write(['recipes', 'tags', 'settings'], tx => {
  for (const name of ['recipes', 'tags', 'settings']) tx.objectStore(name).clear();
  for (const recipe of data.recipes) tx.objectStore('recipes').put(recipe);
  for (const tag of data.tags) tx.objectStore('tags').put(tag);
  tx.objectStore('settings').put({key: 'main', ...data.settings});
}, options);

// Capture content and its durable revision in ONE readonly transaction.
export async function cloudCapture() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['recipes', 'tags', 'settings', 'cloud'], 'readonly'), result = {};
    for (const name of ['recipes', 'tags', 'settings']) {
      const r = tx.objectStore(name).getAll(); r.onsuccess = () => { result[name] = r.result; };
    }
    const r = tx.objectStore('cloud').get('main'); r.onsuccess = () => { result.meta = r.result || defaultCloudState(); };
    tx.oncomplete = () => resolve(result); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
export async function updateCloud(callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cloud', 'readwrite'), store = tx.objectStore('cloud');
    let result;
    const r = store.get('main');
    r.onsuccess = () => {
      try { const meta = r.result || defaultCloudState(); result = callback(meta); store.put(meta); }
      catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => resolve(result); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

// Scheduling and status need only metadata, not a clone of every recipe.
export async function cloudMeta() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cloud', 'readonly'), r = tx.objectStore('cloud').get('main');
    r.onsuccess = () => resolve(r.result || defaultCloudState());
    r.onerror = () => reject(r.error);
  });
}
