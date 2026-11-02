export const SCHEMA_VERSION = 1;
export const APP_VERSION = 'v1.6.0';
export const DEFAULT_GENRES = ['鍋', '炒め物', 'パスタ'];
export const titleOf = text => String(text).split(/\r?\n/).map(line => line.trim()).find(Boolean) || '無題のレシピ';
export const byUpdated = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

export function filterRecipes(recipes, {keyword = '', minimum = 0, tagIds = [], genre = null} = {}) {
  const query = keyword.trim().toLocaleLowerCase();
  return recipes.filter(recipe =>
    (!query || [recipe.title, recipe.recipeText, recipe.notes, recipe.reflection, recipe.nextChanges].some(value => (value || '').toLocaleLowerCase().includes(query))) &&
    (!minimum || (recipe.rating !== null && recipe.rating >= Number(minimum))) &&
    tagIds.every(id => recipe.tagIds.includes(id)) &&
    (genre === null || (recipe.genre || '') === genre)
  ).sort(byUpdated);
}

function recipeContext(recipe, tags) {
  let output = recipe.recipeText;
  output += '\n\n【味の評価】\n' + (recipe.rating === null ? '未評価' : recipe.rating + ' / 10');
  const names = recipe.tagIds.map(id => tags.find(tag => tag.id === id)?.name).filter(Boolean);
  if (names.length) output += '\n\n【タグ】\n' + names.join(' / ');
  if (recipe.genre) output += '\n\n【ジャンル】\n' + recipe.genre;
  if (recipe.notes) output += '\n\n【備考】\n' + recipe.notes;
  if (recipe.reflection) output += '\n\n【前回の反省点】\n' + recipe.reflection;
  if (recipe.nextChanges) output += '\n\n【次回変更したいこと】\n' + recipe.nextChanges;
  return output;
}

export function questionText(recipe, tags) {
  return recipeContext(recipe, tags) + '\n\n以上のレシピについて質問があるので、答えてください。';
}

export function improvementPrompt(recipe, tags) {
  return recipeContext(recipe, tags) + '\n\n【改良の依頼】\n上のレシピを、前回の反省点と次回変更したいことを踏まえて改良してください。材料・分量・作り方に必要な変更を反映し、それ以外の内容はできるだけ維持してください。矛盾や不明点があれば、書き直す前に確認してください。完成したレシピは、1行目を料理名とし、そのままアプリに貼り付けられる平文の全文だけで出力してください。Markdownのコード枠や変更点の解説は不要です。';
}

export const recipeVersion = recipe => recipe.version ?? 1;
export function versionSnapshot(recipe) {
  return {
    version: recipeVersion(recipe), recipeText: recipe.recipeText, notes: recipe.notes,
    reflection: recipe.reflection || '', nextChanges: recipe.nextChanges || '', rating: recipe.rating,
    genre: recipe.genre || '', savedAt: recipe.versionCreatedAt || recipe.createdAt,
    updatedAt: recipe.updatedAt, summary: recipe.versionSummary || '初版'
  };
}
export function createRecipeVersion(recipe, recipeText, summary = '', timestamp = new Date().toISOString()) {
  if (typeof recipeText !== 'string' || !recipeText.trim()) throw new Error('改良後のレシピ全文を貼り付けてください');
  if (recipeText === recipe.recipeText) throw new Error('現在と同じ本文です。変更したレシピを貼り付けてください');
  return {
    ...structuredClone(recipe), recipeText, title: titleOf(recipeText),
    versions: [...structuredClone(recipe.versions || []), versionSnapshot(recipe)],
    version: recipeVersion(recipe) + 1, versionCreatedAt: timestamp,
    versionSummary: summary.trim() || 'レシピを改良', updatedAt: timestamp,
    rating: null, reflection: '', nextChanges: '', improvementText: '', improvementSummary: ''
  };
}

export function aiExport(recipes, tags, exportedAt = new Date().toISOString()) {
  return {
    schemaVersion: SCHEMA_VERSION, exportType: 'ai', exportedAt,
    recipeCount: recipes.length,
    recipes: recipes.map(recipe => ({
      title: recipe.title, recipeText: recipe.recipeText, rating: recipe.rating,
      tags: recipe.tagIds.map(id => tags.find(tag => tag.id === id)?.name).filter(Boolean),
      notes: recipe.notes, genre: recipe.genre || '',
      reflection: recipe.reflection || '', nextChanges: recipe.nextChanges || '', version: recipeVersion(recipe)
    }))
  };
}

export function backupExport(recipes, tags, settings, exportedAt = new Date().toISOString()) {
  return {
    schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, exportType: 'backup',
    exportedAt, recipeCount: recipes.length,
    recipes: structuredClone(recipes), tags: structuredClone(tags),
    settings: {...settings, lastBackupRecipeCount: recipes.length, lastBackupAt: exportedAt, createdSinceBackup: 0},
    backupMetadata: {tagCount: tags.length, includesSettings: true}
  };
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const validGenre = value => typeof value === 'string' && value === value.trim() && value.length <= 50;
const validRating = value => value === null || (Number.isInteger(value) && value >= 1 && value <= 10);
const optionalText = (value, keys) => keys.every(key => value[key] === undefined || typeof value[key] === 'string');

function validVersions(recipe) {
  if (!optionalText(recipe, ['reflection', 'nextChanges', 'improvementText', 'improvementSummary', 'versionSummary'])) return false;
  if (recipe.versionCreatedAt !== undefined && !validDate(recipe.versionCreatedAt)) return false;
  const version = recipe.version === undefined ? 1 : recipe.version, versions = recipe.versions === undefined ? [] : recipe.versions;
  if (!Number.isSafeInteger(version) || version < 1 || !Array.isArray(versions) || versions.length !== version - 1) return false;
  return versions.every((entry, index) => record(entry) && entry.version === index + 1 &&
    typeof entry.recipeText === 'string' && !!entry.recipeText.trim() &&
    ['notes', 'reflection', 'nextChanges', 'summary'].every(key => typeof entry[key] === 'string') &&
    validRating(entry.rating) && validGenre(entry.genre) && validDate(entry.savedAt) && validDate(entry.updatedAt));
}

export function validateBackup(data) {
  const fail = reason => { throw new Error('バックアップを読み込めません: ' + reason); };
  if (!record(data) || data.schemaVersion !== 1 || data.exportType !== 'backup') fail('形式またはバージョンが違います');
  if (!Array.isArray(data.recipes) || !Array.isArray(data.tags) || !record(data.settings) ||
    !record(data.backupMetadata) || !validDate(data.exportedAt)) fail('必須データが不足しています');
  if (!Number.isSafeInteger(data.recipeCount) || data.recipeCount !== data.recipes.length ||
    data.backupMetadata.tagCount !== data.tags.length) fail('件数が一致しません');
  const tagIds = new Set(), names = new Set(), recipeIds = new Set();
  for (const tag of data.tags) {
    if (!record(tag) || typeof tag.id !== 'string' || !tag.id ||
      typeof tag.name !== 'string' || !tag.name.trim() || tag.name !== tag.name.trim() ||
      !validDate(tag.createdAt) || tagIds.has(tag.id) || names.has(tag.name)) fail('タグの内容が不正です');
    tagIds.add(tag.id); names.add(tag.name);
  }
  for (const recipe of data.recipes) {
    if (!record(recipe) || typeof recipe.id !== 'string' || !recipe.id || recipeIds.has(recipe.id) ||
      typeof recipe.recipeText !== 'string' || !recipe.recipeText.trim() ||
      typeof recipe.title !== 'string' || recipe.title !== titleOf(recipe.recipeText) ||
      (recipe.rating !== null && (!Number.isInteger(recipe.rating) || recipe.rating < 1 || recipe.rating > 10)) ||
      typeof recipe.notes !== 'string' || !Array.isArray(recipe.tagIds) || recipe.tagIds.length > 3 ||
      new Set(recipe.tagIds).size !== recipe.tagIds.length ||
      recipe.tagIds.some(id => !tagIds.has(id)) ||
      (recipe.genre !== undefined && !validGenre(recipe.genre)) ||
      !validDate(recipe.createdAt) || !validDate(recipe.updatedAt) || !validVersions(recipe)) fail('レシピまたは改良履歴・タグの関連が不正です');
    recipeIds.add(recipe.id);
  }
  const s = data.settings;
  if (s.genreNames !== undefined && (!Array.isArray(s.genreNames) ||
    s.genreNames.some(name => !validGenre(name) || !name) ||
    new Set(s.genreNames).size !== s.genreNames.length)) fail('ジャンルの内容が不正です');
  if (!Number.isSafeInteger(s.createdSinceBackup) || s.createdSinceBackup < 0 ||
    !Number.isSafeInteger(s.lastBackupRecipeCount) || s.lastBackupRecipeCount < 0 ||
    (s.lastBackupAt !== null && !validDate(s.lastBackupAt))) fail('設定が不正です');
  return data;
}

