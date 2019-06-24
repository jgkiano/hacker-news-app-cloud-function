/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-console */
const _ = require('lodash');
const axios = require('axios');
const moment = require('moment');
const htmlToText = require('html-to-text');
const cheerio = require('cheerio');
const sizeOf = require('image-size');

const MAX_SEC_WAIT = 30;
const db = require('./db');

async function fetchStoredItems(collection) {
  try {
    const snapshot = await db.collection(collection).get();
    const storedItems = snapshot.docs.map(doc => doc.data());
    const refs = snapshot.docs.reduce((acc, doc) => {
      acc[doc.data().id] = doc.ref;
      return acc;
    }, {});
    console.log(`Fetched total items ${storedItems.length} from DB`);
    return { storedItems, refs };
  } catch (error) {
    throw error;
  }
}

async function fetchFreshIds(url) {
  try {
    const { data } = await axios.get(url, { timeout: MAX_SEC_WAIT * 1000 });
    console.log(`Fetched total fresh IDs ${data.length} from HN API`);
    return data;
  } catch (error) {
    throw error;
  }
}

async function fetchImageData(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: MAX_SEC_WAIT * 1000,
      responseType: 'arraybuffer',
    });
    const imageData = sizeOf(data);
    return {
      type: imageData.width < 600 ? 'normal' : 'expanded',
      height: imageData.height,
      width: imageData.width,
      ext: imageData.type,
      url,
    };
  } catch (error) {
    throw error;
  }
}

async function fetchSiteMetaData(url) {
  try {
    const { data } = await axios.get(url, { timeout: MAX_SEC_WAIT * 1000 });
    const $ = cheerio.load(data);
    const description = $("meta[property='og:description']").attr('content') || null;
    const imageUrl = $("meta[property='og:image']").attr('content') || null;
    if (!imageUrl) return { image: null, description };
    try {
      const image = await fetchImageData(imageUrl);
      return { image, description };
    } catch (error) {
      return { image: null, description };
    }
  } catch (error) {
    throw error;
  }
}

async function parseHNData(item, fetchMetaData = false) {
  const base = {
    id: item.id,
    title: item.title,
    date: moment.unix(item.time).toDate(),
    unixTime: item.time,
    author: item.by,
    points: item.score,
    commentCount: item.kids && item.kids.length ? item.kids.length : 0,
    url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
    description: htmlToText.fromString(item.text, { wordwrap: false }) || null,
    image: null,
  };
  if (!fetchMetaData || !base.url) return base;
  try {
    const siteData = await fetchSiteMetaData(base.url);
    return {
      ...base,
      description: base.description || siteData.description || null,
      image: siteData.image,
    };
  } catch (error) {
    return base;
  }
}

async function fetchHNData(id) {
  try {
    const { data } = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
      timeout: MAX_SEC_WAIT * 1000,
    });
    return data;
  } catch (error) {
    throw error;
  }
}

async function fetchFreshData(ids = []) {
  const list = [];
  for (const id of ids) {
    try {
      let item = await fetchHNData(id);
      item = await parseHNData(item, true);
      const time = moment().toDate();
      item = { ...item, createdAt: time, updatedAt: time };
      list.push(item);
      console.log(`Fetched fresh data [${list.length}/${ids.length}]`);
    } catch (error) {
      console.error('[Error] Failed to fetch data for: ', id);
    }
  }
  return list;
}

function includeItemIndex(list = [], originalList = []) {
  return list.map(item => ({
    ...item,
    index: _.indexOf(originalList, item.id),
  }));
}

async function storeItemsInDB(collection, items = []) {
  if (!collection) throw new Error('Missing collection name');
  const batch = db.batch();
  for (const item of items) {
    const ref = db.collection(collection).doc();
    batch.set(ref, item);
  }
  try {
    const result = await batch.commit();
    return result;
  } catch (error) {
    throw error;
  }
}

async function updateItemsInDB(collection, items = [], refs = {}) {
  if (!collection) throw new Error('Missing collection name');
  const batch = db.batch();
  for (const item of items) {
    batch.update(refs[item.id], item);
  }
  try {
    const result = await batch.commit();
    return result;
  } catch (error) {
    throw error;
  }
}

async function deleteItemsInDB(collection, ids = [], refs = {}) {
  if (!collection) throw new Error('Missing collection name');
  const batch = db.batch();
  for (const id of ids) {
    batch.delete(refs[id]);
  }
  try {
    const result = await batch.commit();
    return result;
  } catch (error) {
    throw error;
  }
}

async function fetchUpdateData(items = []) {
  const list = [];
  for (const item of items) {
    try {
      let updateItem = await fetchHNData(item.id);
      updateItem = await parseHNData(updateItem, false);
      updateItem = {
        ...updateItem,
        image: item.image,
        createdAt: item.createdAt,
        updatedAt: moment().toDate(),
      };
      list.push(updateItem);
      console.log(`Fetched update data [${list.length}/${items.length}]`);
    } catch (error) {
      console.error('[Error] Failed to fetch data for: ', item.id);
    }
  }
  return list;
}

async function update(type) {
  try {
    let collection;
    let url;
    if (type === 'stories') {
      collection = 'stories';
      url = 'https://hacker-news.firebaseio.com/v0/topstories.json';
    } else if (type === 'jobs') {
      collection = 'jobs';
      url = 'https://hacker-news.firebaseio.com/v0/jobstories.json?print=pretty';
    } else {
      throw new Error('Invalid type provided');
    }
    const { storedItems, refs } = await fetchStoredItems(collection);
    const storedIds = storedItems.map(item => item.id);
    const freshIds = await fetchFreshIds(url);
    const removeItemsIds = storedIds.filter(id => !_.includes(freshIds, id));
    const fetchItemIds = freshIds.filter(id => !_.includes(storedIds, id));
    const updateItems = storedItems.filter(item => _.includes(freshIds, item.id));

    console.log('Items to be removed: ', removeItemsIds.length);
    console.log('Items to be updated: ', updateItems.length);
    console.log('Items to be fetched: ', fetchItemIds.length);

    let freshData = [];
    let updateData = [];

    if (fetchItemIds.length) {
      freshData = await fetchFreshData(fetchItemIds);
      freshData = includeItemIndex(freshData, freshIds);
    }

    if (updateItems.length) {
      updateData = await fetchUpdateData(updateItems);
      updateData = includeItemIndex(updateData, freshIds);
    }

    if (removeItemsIds.length) {
      // remove ids
      await deleteItemsInDB(collection, removeItemsIds, refs);
      console.log('Items successfully removed from DB');
    }

    if (updateData.length) {
      // update items
      await updateItemsInDB(collection, updateData, refs);
      console.log('Items successfully updated in DB');
    }

    if (freshData.length) {
      // add items
      await storeItemsInDB(collection, freshData);
      console.log('Items successfully added in DB');
    }
  } catch (error) {
    console.error(error);
  }
}

module.exports = update;
