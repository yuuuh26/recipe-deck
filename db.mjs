const NAME = 'recipe-deck';
const VERSION = 1;
let database;

export async function openDatabase() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('tags')) db.createObjectStore('tags', {keyPath: 'id'});
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

export async function write(stores, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
    try { callback(tx); } catch (error) { tx.abort(); reject(error); }
  });
}

export const putRecipe = recipe => write(['recipes'], tx => tx.objectStore('recipes').put(recipe));
export const putSettings = settings => write(['settings'], tx => tx.objectStore('settings').put({key: 'main', ...settings}));
export const removeRecipe = id => write(['recipes'], tx => tx.objectStore('recipes').delete(id));
export const putTag = tag => write(['tags'], tx => tx.objectStore('tags').put(tag));
export const removeTagEverywhere = (id, recipes, updatedAt) => write(['tags', 'recipes'], tx => {
  tx.objectStore('tags').delete(id);
  for (const recipe of recipes) if (recipe.tagIds.includes(id)) {
    tx.objectStore('recipes').put({...recipe, tagIds: recipe.tagIds.filter(item => item !== id), updatedAt});
  }
});
export const replaceAll = data => write(['recipes', 'tags', 'settings'], tx => {
  for (const name of ['recipes', 'tags', 'settings']) tx.objectStore(name).clear();
  for (const recipe of data.recipes) tx.objectStore('recipes').put(recipe);
  for (const tag of data.tags) tx.objectStore('tags').put(tag);
  tx.objectStore('settings').put({key: 'main', ...data.settings});
});
