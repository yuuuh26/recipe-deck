import {initCloud} from './cloud-ui.mjs';
import {titleOf, filterRecipes, questionText, aiExport, backupExport, validateBackup} from './model.mjs';
import {all, write, putSettings, removeRecipe, putTag, removeTagEverywhere, replaceAll} from './db.mjs';

const $ = id => document.getElementById(id);
const settingsDefaults = {lastBackupRecipeCount: 0, lastBackupAt: null, createdSinceBackup: 0};
let recipes = [], tags = [], settings = {...settingsDefaults};
let active = null, page = 'home', revision = 0, savedRevision = 0, timer;
let saveQueue = Promise.resolve(), toastTimer, outputTags = new Set(), homeTags = new Set();
const NOTES_SUMMARY_PROMPT = 'この料理について、ここまで私がした質問と、それぞれの回答を、次回作るときに活用できるよう簡潔にまとめて、備考欄へそのままコピペできる形で出力して。';
const date = value => value ? new Date(value).toLocaleDateString('ja-JP') : 'なし';
const now = () => new Date().toISOString();
const id = prefix => prefix + '_' + crypto.randomUUID();
const element = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};
function toast(message) {
  const node = $('toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}
function status(message, error = false) {
  $('saveStatus').textContent = message;
  $('saveStatus').classList.toggle('error', error);
}
function renderMinimum(select) {
  select.replaceChildren();
  for (let i = 0; i <= 10; i++) {
    const option = new Option(i === 0 ? 'すべて' : i === 10 ? '10点' : i + '点以上', String(i));
    select.add(option);
  }
}
function homeFilter() { return {keyword: $('keyword').value, minimum: Number($('minimum').value), tagIds: [...homeTags]}; }
function exportFilter() { return {keyword: $('exportKeyword').value, minimum: Number($('exportMinimum').value), tagIds: [...outputTags]}; }
function showPage(next) {
  page = next;
  document.querySelectorAll('.page').forEach(node => node.classList.toggle('active', node.id === next));
  document.querySelectorAll('.bottom-nav button').forEach(node => node.classList.toggle('selected', node.dataset.page === next || (next === 'editor' && node.dataset.page === 'home')));
  if (next === 'home') renderHome();
  if (next === 'settings') renderTags();
  if (next === 'export') renderExport();
  scrollTo({top: 0, behavior: 'instant'});
}
async function navigate(next) {
  if (page === 'editor' && next !== 'editor') {
    const okay = await flush();
    if (!okay) return;
    active = null;
  }
  showPage(next);
}
function renderChips(container, selected, onToggle, limit = null) {
  container.replaceChildren();
  if (!tags.length) {
    container.append(element('span', 'help', 'タグはまだありません'));
    return;
  }
  for (const tag of tags) {
    const button = element('button', 'chip' + (selected.has(tag.id) ? ' selected' : ''), tag.name);
    button.type = 'button'; button.setAttribute('aria-pressed', String(selected.has(tag.id)));
    button.disabled = limit !== null && selected.size >= limit && !selected.has(tag.id);
    button.addEventListener('click', () => onToggle(tag.id));
    container.append(button);
  }
}
function renderHome() {
  const found = filterRecipes(recipes, homeFilter());
  $('resultCount').textContent = found.length + ' 件';
  renderChips($('filterTags'), homeTags, tagId => {
    homeTags.has(tagId) ? homeTags.delete(tagId) : homeTags.add(tagId); renderHome();
  });
  const list = $('recipeList'); list.replaceChildren();
  if (!found.length) list.append(element('p', 'empty', recipes.length ? '条件に合うレシピがありません。' : '最初のレシピを追加しましょう。'));
  for (const recipe of found) {
    const card = element('button', 'recipe-card'); card.type = 'button';
    card.append(element('h3', '', recipe.title));
    const meta = element('div', 'meta');
    meta.append(element('span', 'rating-badge' + (recipe.rating >= 7 ? ' liked' : ''), recipe.rating === null ? '評価 —' : '評価 ' + recipe.rating + ' / 10'));
    for (const tagId of recipe.tagIds) {
      const tag = tags.find(item => item.id === tagId);
      if (tag) meta.append(element('span', 'mini-chip', tag.name));
    }
    meta.append(element('span', 'updated', '更新 ' + date(recipe.updatedAt)));
    card.append(meta); card.addEventListener('click', () => openRecipe(recipe)); list.append(card);
  }
  $('backupAlert').classList.toggle('hidden', settings.createdSinceBackup < 10);
}
function renderEditor() {
  $('recipeText').value = active.recipeText;
  $('notes').value = active.notes;
  $('editorTitle').textContent = active.recipeText.trim() ? titleOf(active.recipeText) : '新しいレシピ';
  $('tagCounter').textContent = active.tagIds.length + ' / 3';
  $('ratings').replaceChildren();
  for (let i = 1; i <= 10; i++) {
    const button = element('button', active.rating === i ? 'selected' : '', String(i));
    button.type = 'button'; button.setAttribute('aria-pressed', String(active.rating === i));
    button.addEventListener('click', () => { active.rating = i; changed(); renderEditorControls(); });
    $('ratings').append(button);
  }
  renderEditorControls();
  $('deleteRecipe').hidden = !recipes.some(item => item.id === active.id);
  status(active.recipeText.trim() ? '保存済み' : '本文を入力してください');
}
function renderEditorControls() {
  $('ratings').querySelectorAll('button').forEach((button, index) => {
    button.classList.toggle('selected', active.rating === index + 1);
    button.setAttribute('aria-pressed', String(active.rating === index + 1));
  });
  const selected = new Set(active.tagIds);
  renderChips($('editorTags'), selected, tagId => {
    if (selected.has(tagId)) active.tagIds = active.tagIds.filter(item => item !== tagId);
    else if (selected.size < 3) active.tagIds.push(tagId);
    changed(); renderEditorControls();
  }, 3);
  $('tagCounter').textContent = active.tagIds.length + ' / 3';
}
function openRecipe(recipe = null) {
  active = recipe ? structuredClone(recipe) : {
    id: id('recipe'), title: '無題のレシピ', recipeText: '', rating: null,
    tagIds: [], notes: '', createdAt: now(), updatedAt: now()
  };
  revision = savedRevision = 0; renderEditor(); showPage('editor');
  if (!recipe) $('recipeText').focus();
}
function openCookingMode() {
  if (!active?.recipeText.trim()) { toast('レシピ本文を入力してください'); return; }
  const normalized = active.recipeText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const titleIndex = lines.findIndex(line => line.trim());
  const title = titleIndex >= 0 ? lines[titleIndex].trim() : 'レシピ';
  const body = titleIndex >= 0 ? lines.slice(titleIndex + 1).join('\n').replace(/^\s*\n/, '') : '';
  $('cookingTitle').textContent = title;
  $('cookingBody').textContent = body;
  const notes = (active.notes || '').trim();
  $('cookingNotesText').textContent = notes;
  $('cookingNotes').hidden = !notes;
  if (!$('cookingDialog').open) $('cookingDialog').showModal();
}
function changed() {
  revision++;
  status(active.recipeText.trim() ? '保存中…' : '本文を入力してください');
  clearTimeout(timer);
  if (active.recipeText.trim()) timer = setTimeout(() => persist(), 450);
}
async function persist() {
  clearTimeout(timer);
  if (!active || !active.recipeText.trim()) return true;
  const currentRevision = revision, snapshot = structuredClone(active);
  snapshot.title = titleOf(snapshot.recipeText);
  snapshot.updatedAt = now();
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (currentRevision <= savedRevision) return;
    const previous = recipes.find(item => item.id === snapshot.id);
    if (previous && ['recipeText', 'notes', 'rating'].every(k => previous[k] === snapshot[k]) && JSON.stringify(previous.tagIds) === JSON.stringify(snapshot.tagIds)) {
      savedRevision = currentRevision; if (revision === currentRevision) status('保存済み'); return;
    }
    const isNew = !previous;
    const nextSettings = {...settings, createdSinceBackup: settings.createdSinceBackup + (isNew ? 1 : 0)};
    await write(isNew ? ['recipes', 'settings'] : ['recipes'], tx => {
      tx.objectStore('recipes').put(snapshot);
      if (isNew) tx.objectStore('settings').put({key: 'main', ...nextSettings});
    });
    if (isNew) settings = nextSettings;
    recipes = recipes.filter(item => item.id !== snapshot.id).concat(snapshot);
    savedRevision = currentRevision;
    if (active?.id === snapshot.id) {
      active.createdAt = snapshot.createdAt;
      if (revision === currentRevision) { active.updatedAt = snapshot.updatedAt; status('保存済み'); }
      $('deleteRecipe').hidden = false;
    }
  }).catch(error => {
    if (revision === currentRevision) status('保存できませんでした', true);
    throw error;
  });
  try { await saveQueue; return true; }
  catch (error) { toast('保存に失敗しました。内容をコピーして保護してください'); return false; }
}
async function flush() {
  if (!active || !active.recipeText.trim()) {
    if (active && revision > 0 && (active.notes || active.rating !== null || active.tagIds.length)) {
      toast('保存するにはレシピ本文を入力してください'); return false;
    }
    return true;
  }
  if (revision > savedRevision) return persist();
  try { await saveQueue; return true; } catch { return false; }
}
async function makeTag() {
  const name = prompt('新しいタグ名（短い名前）');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { toast('タグ名を入力してください'); return; }
  if (tags.some(tag => tag.name === trimmed)) { toast('同じ名前のタグが既にあります'); return; }
  const tag = {id: id('tag'), name: trimmed, createdAt: now()};
  try {
    await putTag(tag); tags.push(tag);
    if (page === 'editor' && active.tagIds.length < 3) { active.tagIds.push(tag.id); changed(); renderEditorControls(); }
    renderHome(); renderTags(); toast('タグを作成しました');
  } catch { toast('タグを保存できませんでした'); }
}
function renderTags() {
  const manager = $('managedTags'); manager.replaceChildren();
  if (!tags.length) manager.append(element('p', 'help', 'タグはまだありません'));
  for (const tag of tags) {
    const row = element('div', 'tag-row');
    row.append(element('span', '', tag.name));
    const button = element('button', '', '削除');
    button.addEventListener('click', async () => {
      if (!confirm('「' + tag.name + '」タグを削除しますか？\nこのタグは、使用中のすべてのレシピからも外れます。')) return;
      try {
        const changedAt = now();
        await removeTagEverywhere(tag.id, recipes, changedAt);
        recipes = recipes.map(recipe => recipe.tagIds.includes(tag.id) ? {...recipe, tagIds: recipe.tagIds.filter(item => item !== tag.id), updatedAt: changedAt} : recipe);
        tags = tags.filter(item => item.id !== tag.id);
        homeTags.delete(tag.id); outputTags.delete(tag.id); renderTags(); toast('タグを削除しました');
      } catch { toast('タグを削除できませんでした'); }
    });
    row.append(button); manager.append(row);
  }
}
function renderExport() {
  renderChips($('exportTags'), outputTags, tagId => {
    outputTags.has(tagId) ? outputTags.delete(tagId) : outputTags.add(tagId); renderExport();
  });
  $('backupStats').replaceChildren(
    element('div', '', '現在のレシピ数：' + recipes.length + ' 件'),
    element('div', '', '前回バックアップ：' + date(settings.lastBackupAt)),
    element('div', '', '前回バックアップ時：' + settings.lastBackupRecipeCount + ' 件'),
    element('div', '', '次回推奨まで：あと ' + Math.max(0, 10 - settings.createdSinceBackup) + ' 件')
  );
}
function showJson(selected) {
  const json = JSON.stringify(aiExport(selected, tags), null, 2);
  $('jsonOutput').value = json;
  $('jsonSummary').textContent = selected.length + ' 件のレシピ（AI用。復旧には使えません）';
  $('jsonDialog').showModal();
}
function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([data], {type: 'application/json;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); toast('コピーしました'); return true; }
  catch { toast('コピーできませんでした。テキスト欄から手動でコピーしてください'); return false; }
}
async function shareText(value, title = 'Recipe Deck') {
  if (navigator.share) {
    try {
      await navigator.share({title, text: value});
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
    }
  }
  const copied = await copy(value);
  if (copied) toast('共有画面を開けないため、クリップボードにコピーしました');
  return copied;
}
async function shareJsonFile(data, filename) {
  const file = new File([data], filename, {type: 'application/json'});
  if (navigator.share && navigator.canShare?.({files: [file]})) {
    try {
      await navigator.share({title: 'Recipe Deck AI用JSON', files: [file]});
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
    }
  }
  downloadJson(data, filename);
  toast('共有画面を開けないため、JSONファイルを保存しました');
  return false;
}
async function importBackup(file) {
  if (!file) return;
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
    const data = validateBackup(JSON.parse(await file.text()));
    if (!confirm('現在のデータ：' + recipes.length + ' 件\nバックアップ：' + data.recipeCount + ' 件\n\n復元すると現在のデータが置き換えられます。続けますか？')) return;
    await replaceAll(data);
    recipes = data.recipes; tags = data.tags; settings = {...settingsDefaults, ...data.settings};
    homeTags.clear(); outputTags.clear(); active = null; $('backupConfirmation').classList.add('hidden');
    $('importFile').value = ''; showPage('home');
    toast(recipes.length + ' 件のレシピと ' + tags.length + ' 件のタグを復元しました');
  } catch (error) { toast(error.message || '復元に失敗しました。元のデータは変更していません'); }
  finally { $('importFile').value = ''; }
}
async function storageStatus() {
  const node = $('storageState');
  if (!navigator.storage?.persist) { node.textContent = '非対応'; return; }
  try {
    const already = await navigator.storage.persisted();
    node.textContent = already || await navigator.storage.persist() ? '有効' : '未取得';
  } catch { node.textContent = '未取得'; }
}
function wire() {
  renderMinimum($('minimum')); renderMinimum($('exportMinimum'));
  document.querySelectorAll('.bottom-nav button').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
  $('settingsShortcut').addEventListener('click', () => navigate('settings'));
  $('addRecipe').addEventListener('click', () => openRecipe());
  $('backHome').addEventListener('click', () => navigate('home'));
  $('alertBackup').addEventListener('click', () => navigate('export'));
  $('keyword').addEventListener('input', renderHome);
  $('minimum').addEventListener('change', renderHome);
  $('recipeText').addEventListener('input', event => { active.recipeText = event.target.value; $('editorTitle').textContent = titleOf(active.recipeText); changed(); });
  $('openCookingMode').addEventListener('click', async () => { if (await flush()) openCookingMode(); });
  $('closeCookingMode').addEventListener('click', () => $('cookingDialog').close());
  $('notes').addEventListener('input', event => { active.notes = event.target.value; changed(); });
  $('copyNotesSummaryPrompt').addEventListener('click', () => void copy(NOTES_SUMMARY_PROMPT));
  $('clearRating').addEventListener('click', () => { active.rating = null; changed(); renderEditorControls(); });
  $('createTagHere').addEventListener('click', makeTag);
  $('createTagInSettings').addEventListener('click', makeTag);
  $('deleteRecipe').addEventListener('click', async () => {
    if (!active || !confirm('「' + titleOf(active.recipeText) + '」を削除しますか？')) return;
    clearTimeout(timer);
    if (!await flush()) return;
    try {
      await removeRecipe(active.id); recipes = recipes.filter(item => item.id !== active.id);
      active = null; showPage('home'); toast('レシピを削除しました');
    } catch { toast('削除できませんでした'); }
  });
  $('copyQuestion').addEventListener('click', () => {
    if (!active?.recipeText.trim()) { toast('レシピ本文を入力してください'); return; }
    if (revision > savedRevision) void persist();
    void shareText(questionText(active, tags), titleOf(active.recipeText) + 'について質問');
  });
  $('exportAll').addEventListener('click', () => showJson(recipes.slice().sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))));
  $('exportResults').addEventListener('click', () => showJson(filterRecipes(recipes, homeFilter())));
  $('exportFiltered').addEventListener('click', () => showJson(filterRecipes(recipes, exportFilter())));
  $('copyJson').addEventListener('click', () => shareText($('jsonOutput').value, 'Recipe Deck AI用JSON'));
  $('downloadJson').addEventListener('click', () => shareJsonFile($('jsonOutput').value, 'recipe-deck-ai-' + new Date().toISOString().slice(0,10) + '.json'));
  $('closeJson').addEventListener('click', () => $('jsonDialog').close());
  $('downloadBackup').addEventListener('click', () => {
    try {
      const backup = backupExport(recipes, tags, settings);
      const createdAtDownload = settings.createdSinceBackup;
      downloadJson(JSON.stringify(backup, null, 2), 'recipe-deck-backup-' + new Date().toISOString().slice(0,10) + '.json');
      $('backupConfirmation').classList.remove('hidden');
      $('confirmBackup').onclick = async () => {
        try {
          const createdAfterDownload = Math.max(0, settings.createdSinceBackup - createdAtDownload);
          const next = {...settings, lastBackupRecipeCount: backup.recipeCount, lastBackupAt: backup.exportedAt, createdSinceBackup: createdAfterDownload};
          await putSettings(next); settings = next; $('backupConfirmation').classList.add('hidden');
          renderExport(); toast('バックアップを記録しました');
        } catch { toast('バックアップ日時を記録できませんでした'); }
      };
    } catch { toast('バックアップを作成できませんでした'); }
  });
  $('importFile').addEventListener('change', event => importBackup(event.target.files[0]));
  $('copyUrl').addEventListener('click', () => copy(location.href.split('#')[0]));
  $('copyRepo').addEventListener('click', () => copy('https://github.com/yuuuh26/recipe-deck'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && page === 'editor') void flush(); });
}
async function init() {
  wire();
  try {
    [recipes, tags] = await Promise.all([all('recipes'), all('tags')]);
    settings = {...settingsDefaults, ...(await all('settings')).find(item => item.key === 'main')};
    showPage('home'); storageStatus();
    await initCloud({flush, toast, download: downloadJson, restored: async data => {
      recipes = data.recipes; tags = data.tags; settings = {...settingsDefaults, ...data.settings};
      homeTags.clear(); outputTags.clear(); active = null; showPage('home');
    }});
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  } catch (error) {
    $('recipeList').replaceChildren(element('p', 'empty', 'データを開けませんでした。ブラウザーの保存設定を確認してください。'));
    toast('保存領域を開けませんでした');
    document.querySelectorAll('button,input,textarea').forEach(node => { if (node.id !== 'copyUrl') node.disabled = true; });
  }
}
init();
