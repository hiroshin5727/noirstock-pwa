import { createSalesChannel, createListingRecord, createEvent } from './schema.js';
import { num, todayISO } from './utils.js';

export function channelTypeText(type) {
  return {
    online: 'ネット',
    store: '店舗',
    event: 'イベント',
    consignment: '委託',
    direct: '直接販売'
  }[type] || 'その他';
}

export function listingStatusText(status) {
  return {
    listed: '出品中',
    unlisted: '取り下げ',
    sold: '販売済'
  }[status] || '出品中';
}

export function addSalesChannel(data, input) {
  const channel = createSalesChannel(input);
  data.salesChannels.push(channel);
  return channel;
}

export function addListingRecord(data, input) {
  const listing = createListingRecord(input);
  data.listingRecords.push(listing);
  const inv = data.inventories.find(i => i.id === listing.inventoryId);
  if (inv) {
    inv.currentListingIds ||= [];
    if (!inv.currentListingIds.includes(listing.id)) inv.currentListingIds.push(listing.id);
    if (inv.status === 'stock') inv.status = 'listed';
  }
  return listing;
}

export function addEventRecord(data, input) {
  let channelId = input.channelId || '';
  if (!channelId && input.eventName) {
    const channel = addSalesChannel(data, {
      name: input.eventName,
      type: 'event',
      fixedFee: num(input.boothFee) + num(input.transportCost) + num(input.otherCost),
      location: input.location || '',
      memo: input.memo || ''
    });
    channelId = channel.id;
  }
  const event = createEvent({ ...input, channelId });
  data.events.push(event);
  return event;
}

export function activeListingsForInventory(data, inventoryId) {
  return data.listingRecords.filter(l => l.inventoryId === inventoryId && l.status === 'listed');
}

export function markListingSold(data, listingId, saleId) {
  if (!listingId) return;
  const listing = data.listingRecords.find(l => l.id === listingId);
  if (!listing) return;
  listing.status = 'sold';
  listing.soldSaleId = saleId;
  const inv = data.inventories.find(i => i.id === listing.inventoryId);
  if (inv) inv.currentListingIds = (inv.currentListingIds || []).filter(id => id !== listing.id);
}

export function unlistListing(data, listingId) {
  const listing = data.listingRecords.find(l => l.id === listingId);
  if (!listing) return;
  listing.status = 'unlisted';
  listing.unlistedAt = todayISO();
  const inv = data.inventories.find(i => i.id === listing.inventoryId);
  if (inv) inv.currentListingIds = (inv.currentListingIds || []).filter(id => id !== listing.id);
}
