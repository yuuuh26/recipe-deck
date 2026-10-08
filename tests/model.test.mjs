import test from 'node:test';
import assert from 'node:assert/strict';
import {titleOf, filterRecipes, questionText, aiExport, backupExport, validateBackup} from '../model.mjs';

const tags = [
  {id: 'a', name: '時短', createdAt: '2026-09-27T00:00:00Z'},
  {id: 'b', name: '妻好評', createdAt: '2026-09-27T00:00:00Z'}
];
const recipes = [
  {id:'r1', recipeText:'\n鶏肉炒め\n\n【材料】\n鶏肉 200g', title:'鶏肉炒め', rating:7, tagIds:['a','b'], notes:'妻に好評', createdAt:'2026-09-27T00:00:00Z', updatedAt:'2026-09-27T00:00:00Z'},
  {id:'r2', recipeText:'味噌汁\n豆腐', title:'味噌汁', rating:6, tagIds:['a'], notes:'鶏肉を添える', createdAt:'2026-09-27T00:00:00Z', updatedAt:'2026-09-27T01:00:00Z'},
  {id:'r3', recipeText:'サラダ', title:'サラダ', rating:null, tagIds:['b'], notes:'', createdAt:'2026-09-27T00:00:00Z', updatedAt:'2026-09-27T02:00:00Z'}
];

test('title is first nonblank line without changing the original text', () => {
  assert.equal(titleOf(recipes[0].recipeText), '鶏肉炒め');
  assert.ok(recipes[0].recipeText.startsWith('\n'));
});
test('keyword, rating threshold and multiple tags combine using AND', () => {
  assert.deepEqual(filterRecipes(recipes,{keyword:'鶏肉',minimum:7,tagIds:['a','b']}).map(r=>r.id), ['r1']);
  assert.deepEqual(filterRecipes(recipes,{minimum:7}).map(r=>r.id), ['r1']);
  assert.deepEqual(filterRecipes(recipes,{minimum:6}).map(r=>r.id), ['r2','r1']);
  assert.deepEqual(filterRecipes(recipes,{keyword:'豆腐'}).map(r=>r.id), ['r2']);
});
test('AI output and question text preserve newlines, notes and tag names', () => {
  const data = aiExport([recipes[0]],tags);
  assert.equal(JSON.parse(JSON.stringify(data)).recipes[0].recipeText, recipes[0].recipeText);
  assert.deepEqual(data.recipes[0].tags, ['時短','妻好評']);
  const question = questionText(recipes[0],tags);
  assert.ok(question.startsWith(recipes[0].recipeText + '\n\n'));
  assert.match(question, /【備考】\n妻に好評/);
  assert.ok(question.endsWith('以上のレシピについて質問があるので、答えてください。'));
});
test('backup round trip includes independent tag masters and settings', () => {
  const data = backupExport(recipes,tags,{lastBackupRecipeCount:1,lastBackupAt:null,createdSinceBackup:2});
  const parsed = validateBackup(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(parsed.recipes,recipes);
  assert.deepEqual(parsed.tags,tags);
  assert.equal(parsed.settings.createdSinceBackup,0);
  assert.equal(parsed.settings.lastBackupRecipeCount,3);
});
test('damaged backup is rejected before restoration', () => {
  const backup = backupExport(recipes,tags,{lastBackupRecipeCount:0,lastBackupAt:null,createdSinceBackup:0});
  const check = modify => { const copy = structuredClone(backup); modify(copy); assert.throws(()=>validateBackup(copy)); };
  check(data=>data.recipeCount++);
  check(data=>data.recipes[0].tagIds.push('missing'));
  check(data=>data.recipes[0].tagIds.push('a','b'));
  check(data=>data.recipes[0].rating=11);
  check(data=>data.tags[1].name='時短');
  check(data=>data.exportType='ai');
});
test('ジャンルは他の条件と組み合わせられ、旧レシピは未設定として探せる', () => {
  const classified = recipes.map((recipe, index) => index === 0 ? {...recipe, genre: '炒め物'} : recipe);
  assert.deepEqual(filterRecipes(classified, {genre:'炒め物', keyword:'鶏肉', minimum:7, tagIds:['a','b']}).map(r=>r.id), ['r1']);
  assert.deepEqual(filterRecipes(classified, {genre:''}).map(r=>r.id), ['r3','r2']);
  assert.deepEqual(filterRecipes(classified, {genre:'鍋'}), []);
  assert.equal(aiExport(classified,tags).recipes[0].genre, '炒め物');
  assert.match(questionText(classified[0],tags), /【ジャンル】\n炒め物/);
  const data = backupExport(classified, tags, {lastBackupRecipeCount:0,lastBackupAt:null,createdSinceBackup:0,genreNames:['炒め物','パスタ','丼物']});
  assert.deepEqual(validateBackup(JSON.parse(JSON.stringify(data))).settings.genreNames, ['炒め物','パスタ','丼物']);
  assert.equal(validateBackup(data).recipes[0].genre, '炒め物');
  for (const genre of [null, [], ' 炒め物', 'あ'.repeat(51)]) {
    const bad = structuredClone(data); bad.recipes[0].genre = genre; assert.throws(()=>validateBackup(bad));
  }
  const bad = structuredClone(data); bad.settings.genreNames.push('炒め物'); assert.throws(()=>validateBackup(bad));
});
