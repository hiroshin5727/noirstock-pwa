import {createEmptyDataset} from './schema.js';import {normalizeToV64} from './compat.js';import {deepClone,nowISO} from './utils.js';
const KEY='noirstock.dataset.v64',BACKUP_KEY='noirstock.autoBackups.v64';let dataset=null;
export function loadDataset(){if(dataset)return dataset;const raw=localStorage.getItem(KEY);if(!raw){dataset=createEmptyDataset();saveDataset(dataset);return dataset}try{dataset=normalizeToV64(JSON.parse(raw))}catch(e){console.error(e);dataset=createEmptyDataset()}return dataset}
export function saveDataset(next=dataset){dataset=next||createEmptyDataset();dataset.updatedAt=nowISO();localStorage.setItem(KEY,JSON.stringify(dataset));return dataset}
export function replaceDataset(next){dataset=normalizeToV64(next);saveDataset(dataset);return dataset}
export const getDataset=()=>loadDataset();
export function patchDataset(mutator){const d=loadDataset();mutator(d);saveDataset(d);return d}
export function createAutoBackup(reason='backup'){const backups=JSON.parse(localStorage.getItem(BACKUP_KEY)||'[]');backups.unshift({id:`${Date.now()}`,reason,createdAt:nowISO(),dataset:deepClone(loadDataset())});localStorage.setItem(BACKUP_KEY,JSON.stringify(backups.slice(0,10)))}
export const getAutoBackups=()=>JSON.parse(localStorage.getItem(BACKUP_KEY)||'[]');
export function resetDataset(){dataset=createEmptyDataset();saveDataset(dataset);return dataset}
