export const SCHEMA_VERSION = 1;
export const APP_VERSION = 'v1.2.0';
export const titleOf = text => String(text).split(/\r?\n/).map(line => line.trim()).find(Boolean) || '無題のレシピ';
export const byUpdated = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

export function filterRecipes(recipes, {keyword = '', minimum = 0, tagIds = []} = {}) {
  const query = keyword.trim().toLocaleLowerCase();
  return recipes.filter(recipe =>
    (!query || [recipe.title, recipe.recipeText, recipe.notes].some(value => value.toLocaleLowerCase().includes(query))) &&
    (!minimum || (recipe.rating !== null && recipe.rating >= Number(minimum))) &&
    tagIds.every(id => recipe.tagIds.includes(id))
  ).sort(byUpdated);
}

export function questionText(recipe, tags) {
  let output = recipe.recipeText;
  output += '\n\n【味の評価】\n' + (recipe.rating === null ? '未評価' : recipe.rating + ' / 10');
  const names = recipe.tagIds.map(id => tags.find(tag => tag.id === id)?.name).filter(Boolean);
  if (names.length) output += '\n\n【タグ】\n' + names.join(' / ');
  if (recipe.notes) output += '\n\n【備考】\n' + recipe.notes;
  return output + '\n\n以上のレシピについて質問があるので、答えてください。';
}

export function aiExport(recipes, tags, exportedAt = new Date().toISOString()) {
  return {
    schemaVersion: SCHEMA_VERSION, exportType: 'ai', exportedAt,
    recipeCount: recipes.length,
    recipes: recipes.map(recipe => ({
      title: recipe.title, recipeText: recipe.recipeText, rating: recipe.rating,
      tags: recipe.tagIds.map(id => tags.find(tag => tag.id === id)?.name).filter(Boolean),
      notes: recipe.notes
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
      !validDate(recipe.createdAt) || !validDate(recipe.updatedAt)) fail('レシピまたはタグの関連が不正です');
    recipeIds.add(recipe.id);
  }
  const s = data.settings;
  if (!Number.isSafeInteger(s.createdSinceBackup) || s.createdSinceBackup < 0 ||
    !Number.isSafeInteger(s.lastBackupRecipeCount) || s.lastBackupRecipeCount < 0 ||
    (s.lastBackupAt !== null && !validDate(s.lastBackupAt))) fail('設定が不正です');
  return data;
}
