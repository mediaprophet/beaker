/**
 * The indexer creates the following datasets:
 * 
 *  - List of sites that have been indexed
 *  - List of records that have been indexed
 *  - Metadata & file content for all indexed records (including FTS index)
 *  - Notifications for records which are relevant to the user
 * 
 * The indexer works by periodically listing all sites that we're interested in and
 * fetching a list of file updates since the last time the site was indexed. Those
 * updates are then passed into a set of "index definitions" which pick which updates
 * to index based on their metadata.
 * 
 * Sites which the user has "lost interest in" (ie unsubscribed from) will be deleted
 * from the index.
 * 
 * Current limitations:
 * 
 *  - Unable to index http/s sites
 *  - If any updates to a hyper site failes to index, the site will stop being indexed
 *  - Only subscribed and owned sites are indexed
 */

import { app } from 'electron'
import knex from 'knex'
import { dirname, extname } from 'path'
import { EventEmitter } from 'events'
import emitStream from 'emit-stream'
import markdownLinkExtractor from 'markdown-link-extractor'
import { PermissionsError } from 'beaker-error-constants'
import { attachOnConflictDoNothing } from 'knex-on-conflict-do-nothing'
import { attachOnConflictDoUpdate } from '../lib/db'
import * as path from 'path'
import mkdirp from 'mkdirp'
import * as logLib from '../logger'
const logger = logLib.get().child({category: 'indexer'})
import { TICK_INTERVAL, METADATA_KEYS } from './const'
import * as hyperbees from './hyperbees'
import * as local from './local'
import * as filesystem from '../filesystem/index'
import lock from '../../lib/lock'
import { joinPath, toNiceUrl, parseSimplePathSpec } from '../../lib/strings'
import { normalizeOrigin, normalizeUrl } from '../../lib/urls'
import {
  getIsFirstRun,
  getIndexState,
  updateIndexState,
  setSiteFlags,
  listMyOrigins,
  listOriginsToIndex,
  listOriginsToCapture,
  listOriginsToDeindex,
  loadSite,
  checkShouldExcludePrivate,
  parseUrl,
  isUrl,
  toArray,
  parallel
} from './util'

/**
 * @typedef {import('./const').Site} Site
 * @typedef {import('./const').SiteDescription} SiteDescription
 * @typedef {import('./const').SiteDescriptionGraph} SiteDescriptionGraph
 * @typedef {import('./const').RecordUpdate} RecordUpdate
 * @typedef {import('./const').ParsedUrl} ParsedUrl
 * @typedef {import('./const').RecordDescription} RecordDescription
 * @typedef {import('../../lib/session-permissions').EnumeratedSessionPerm} EnumeratedSessionPerm
 * @typedef {import('../filesystem/query').FSQueryResult} FSQueryResult
 * @typedef {import('./const').NotificationQuery} NotificationQuery
 */

// globals
// =

var db
var state = {
  status: {
    task: '',
    nextRun: undefined
  },
  sites: {},
  queue: [],
  targets: []
}
var events = new EventEmitter()

// exported api
// =

/**
 * @param {Object} opts
 * @param {string} opts.userDataPath
 */
export async function setup (opts) {
  mkdirp.sync(path.join(opts.userDataPath, 'Indexes'))
  attachOnConflictDoNothing(knex)
  attachOnConflictDoUpdate(knex)
  db = knex({
    client: 'sqlite3',
    connection: {
      filename: path.join(opts.userDataPath, 'Indexes', 'beaker.db')
    },
    useNullAsDefault: true
  })
  await db.migrate.latest({directory: path.join(app.getAppPath(), 'bg', 'indexer', 'migrations')})
  await hyperbees.setup()
  tick()

  // fetch current sites states for debugging
  {
    let states = await db('sites')
      .select('origin', 'last_indexed_version', 'last_indexed_ts')
    for (let state of states) {
      DEBUGGING.setSiteState({
        url: state.origin,
        progress: undefined,
        last_indexed_version: state.last_indexed_version,
        last_indexed_ts: state.last_indexed_ts,
        error: undefined
      })
    }
  }
}

export async function clearAllData () {
  try {
    var release = await lock('beaker-indexer')
    await db('sites').del()
  } finally {
    release()
  }
}

/**
 * @param {String} url 
 * @param {Object} [opts]
 * @param {Object} [opts.cacheOnly]
 * @returns {Promise<SiteDescription>}
 */
export async function getSite (url, opts) {
  var origin = normalizeOrigin(url)
  if (!origin.startsWith('hyper://')) return undefined // hyper only for now
  var siteRows = await db('sites').select('*').where({origin}).limit(1)
  if (siteRows[0]) {
    return {
      origin: siteRows[0].origin,
      url: siteRows[0].origin,
      title: siteRows[0].title || toNiceUrl(siteRows[0].origin),
      description: siteRows[0].description,
      writable: Boolean(siteRows[0].writable),
      index: {id: 'local'},
      graph: await getSiteGraph(origin)
    }
  }
  var hyperbeeResult = await hyperbees.getSite(url)
  if (hyperbeeResult) {
    hyperbeeResult.graph = await getSiteGraph(origin)
    return hyperbeeResult
  }
  if (opts?.cacheOnly) {
    return {
      origin: origin,
      url: origin,
      title: toNiceUrl(origin),
      description: '',
      writable: false,
      index: {id: 'network'},
      graph: await getSiteGraph(origin)
    }
  }
  var site = await loadSite(db, origin)
  return {
    origin: site.origin,
    url: site.origin,
    title: site.title,
    description: site.description,
    writable: site.writable,
    index: {id: 'live'},
    graph: await getSiteGraph(site.origin)
  }
}

/**
 * @param {Object} [opts]
 * @param {String} [opts.search]
 * @param {String|String[]} [opts.index] - 'local', 'network', url of a specific hyperbee index
 * @param {Boolean} [opts.writable]
 * @param {Number} [opts.offset]
 * @param {Number} [opts.limit]
 * @returns {Promise<SiteDescription[]>}
 */
export async function listSites (opts) {
  opts = opts && typeof opts === 'object' ? opts : {}
  opts.index = opts.index ? toArray(opts.index) : ['local']

  var results = []
  if (opts.index.includes('local')) {
    results.push(await local.listSites(db, opts))
  }
  if (opts.index.includes('network')) {
    results.push(await hyperbees.listSites(opts))
  }

  var sites
  if (results.length === 1) {
    sites = results[0]
  } else {
    sites = []
    for (let result of results.flat()) {
      if (!sites.find(s => s.url === result.url)) {
        sites.push(result)
      }
    }
  }

  await Promise.all(sites.map(async site => {
    site.graph = await getSiteGraph(site.origin)
  }))

  return sites
}

/**
 * @param {String} url 
 * @param {Object} [permissions]
 * @param {EnumeratedSessionPerm[]} [permissions.query]
 * @returns {Promise<RecordDescription>}
 */
export async function get (url, permissions) {
  let urlp = parseUrl(url)
  if (permissions?.query) {
    if (urlp.origin === 'hyper://private') {
      let prefix = dirname(urlp.pathname)
      let extension = extname(urlp.pathname)
      let perm = permissions.query.find(perm => perm.prefix === prefix && perm.extension === extension)
      if (!perm) throw new PermissionsError()
    }
  }
  var rows = await db('sites')
    .leftJoin('records', 'sites.rowid', 'records.site_rowid')
    .select('*', 'records.rowid as record_rowid')
    .where({
      'origin': urlp.origin,
      'path': urlp.path
    })
    .limit(1)
  if (!rows[0]) {
    return getLiveRecord(url)
  }

  var record_rowid = rows[0].record_rowid
  var result = {
    type: 'file',
    path: urlp.path,
    url: urlp.origin + urlp.path,
    ctime: rows[0].ctime,
    mtime: rows[0].mtime,
    metadata: {},
    index: {
      id: 'local',
      rtime: rows[0].rtime,
      links: []
    },
    site: {
      url: urlp.origin,
      title: rows[0].title || toNiceUrl(urlp.origin)
    },
    content: undefined
  }

  rows = await db('records_data').select('*').where({record_rowid})
  for (let row of rows) {
    if (row.key === METADATA_KEYS.content) {
      result.content = row.value
    } else if (row.key === METADATA_KEYS.link) {
      result.index.links.push(row.value)
    } else {
      result.metadata[row.key] = row.value
    }
  }

  return result
}

/**
 * @param {Object} [opts]
 * @param {String|String[]} [opts.origin]
 * @param {String|String[]} [opts.path]
 * @param {String} [opts.links]
 * @param {Boolean|NotificationQuery} [opts.notification]
 * @param {String|String[]} [opts.index] - 'local', 'network', url of a specific hyperbee index
 * @param {String} [opts.sort]
 * @param {Number} [opts.offset]
 * @param {Number} [opts.limit]
 * @param {Boolean} [opts.reverse]
 * @param {Object} [permissions]
 * @param {EnumeratedSessionPerm[]} [permissions.query]
 * @returns {Promise<RecordDescription[]>}
 */
export async function query (opts, permissions) {
  opts = opts && typeof opts === 'object' ? opts : {}
  opts.reverse = (typeof opts.reverse === 'boolean') ? opts.reverse : true
  if (!opts.sort || !['ctime', 'mtime', 'rtime', 'crtime', 'mrtime', 'origin'].includes(opts.sort)) {
    opts.sort = 'crtime'
  }
  opts.offset = opts.offset || 0
  opts.index = opts.index ? toArray(opts.index) : ['local']

  var notificationRtimes
  if (opts?.notification) {
    notificationRtimes = await getNotificationsRtimes()
  }

  var results = []
  if (opts.index.includes('local')) {
    results.push(await local.query(db, opts, {
      permissions,
      notificationRtime: notificationRtimes?.local_notifications_rtime
    }))
  }
  if (opts.index.includes('network')) {
    results.push(await hyperbees.query(opts, {
      existingResults: results[0]?.records,
      notificationRtime: notificationRtimes?.network_notifications_rtime
    }))
  }
  
  // identify origins which we need to live-query
  var missedOrigins = results[0].missedOrigins || []
  if (results[1] && results[1].missedOrigins?.length) {
    missedOrigins = missedOrigins.filter(org => results[1].missedOrigins.includes(org))
  }

  if (missedOrigins.length) {
    // fetch the live records
    let records
    for (let origin of missedOrigins) {
      try {
        records = (records || []).concat(
          await listLiveRecords(origin, opts)
        )
      } catch (e) {
        logger.silly(`Failed to live-list records from ${origin}`, {error: e})
      }
    }
    if (records && records?.length) {
      results.push({records})
    }
  }

  var records
  if (results.length > 0) {
    // merge and sort
    records = results.reduce((acc, res) => acc.concat(res.records), [])
    records.sort((a, b) => {
      if (opts.sort === 'ctime') {
        return opts.reverse ? (b.ctime - a.ctime) : (a.ctime - b.ctime)
      } else if (opts.sort === 'mtime') {
        return opts.reverse ? (b.mtime - a.mtime) : (a.mtime - b.mtime)
      } else if (opts.sort === 'crtime') {
        let crtimeA = Math.min(a.ctime, a.index.rtime)
        let crtimeB = Math.min(b.ctime, b.index.rtime)
        return opts.reverse ? (crtimeB - crtimeA) : (crtimeA - crtimeB)
      } else if (opts.sort === 'mrtime') {
        let mrtimeA = Math.min(a.mtime, a.index.rtime)
        let mrtimeB = Math.min(b.mtime, b.index.rtime)
        return opts.reverse ? (mrtimeB - mrtimeA) : (mrtimeA - mrtimeB)
      } else if (opts.sort === 'origin') {
        return b.site.url.localeCompare(a.site.url) * (opts.reverse ? -1 : 1)
      }
    })
    if (typeof opts.offset === 'number' && typeof opts.limit === 'number') {
      records = records.slice(opts.offset, opts.offset + opts.limit)
    } else if (typeof opts.offset === 'number') {
      records = records.slice(opts.offset)
    } else if (typeof opts.limit === 'number') {
      records = records.slice(0, opts.limit)
    }

    // load data as needed
    for (let record of records) {
      if (record.fetchData) {
        try {
          await record.fetchData()
        } catch {
          // ignore
        }
        delete record.fetchData
      }
    }
  } else {
    records = results[0].records
  }

  return records
}

/**
 * @param {Object} [opts]
 * @param {String|Array<String>} [opts.origin]
 * @param {String|Array<String>} [opts.path]
 * @param {String} [opts.links]
 * @param {Boolean|NotificationQuery} [opts.notification]
 * @param {String|String[]} [opts.index] - 'local' or 'network'
 * @param {Object} [permissions]
 * @param {EnumeratedSessionPerm[]} [permissions.query]
 * @returns {Promise<Number>}
 */
export async function count (opts, permissions) {
  opts = opts && typeof opts === 'object' ? opts : {}
  opts.index = opts.index ? toArray(opts.index) : ['local']

  var notificationRtimes
  if (opts?.notification) {
    notificationRtimes = await getNotificationsRtimes()
  }

  var results = []
  if (opts.index.includes('local')) {
    results.push(await local.count(db, opts, {
      permissions,
      notificationRtime: notificationRtimes?.local_notifications_rtime
    }))
  }
  if (opts.index.includes('network')) {
    results.push(await hyperbees.count(opts, {
      existingResultOrigins: results[0]?.includedOrigins,
      notificationRtime: notificationRtimes?.network_notifications_rtime
    }))
  }
  
  // identify origins which we need to live-query
  var missedOrigins = results[0].missedOrigins || []
  if (results[1] && results[1].missedOrigins?.length) {
    missedOrigins = missedOrigins.filter(org => results[1].missedOrigins.includes(org))
  }

  if (missedOrigins.length) {
    // fetch the live records
    for (let origin of missedOrigins) {
      try {
        let files = await listLiveRecords(origin, opts)
        results.push({count: files.length})
      } catch (e) {
        logger.silly(`Failed to live-count records from ${origin}`, {error: e})
      }
    }
  }

  // DEBUG
  // we're getting inaccurate "unread notifications" counts, so we need to log some info to track that done
  // remove me in the future, please
  // -prf
  var count = results.reduce((acc, result) => acc + result.count, 0)
  if (opts?.notification?.unread && count > 0 && count < 6) {
    logger.debug(`Unread notifications: ${count}`)
    query({index: ['local', 'network'], notification: {unread: true}}).then(
      res => logger.debug(`Full list of unread: ${JSON.stringify(res)}`),
      err => logger.debug(`Failed to get list of unread: ${err.toString()}`)
    )
  }

  return count
}

/**
 * @param {String} [q]
 * @param {Object} [opts]
 * @param {String|Array<String>} [opts.origin]
 * @param {String|Array<String>} [opts.path]
 * @param {String|Array<String>} [opts.field]
 * @param {Boolean|NotificationQuery} [opts.notification]
 * @param {String} [opts.sort]
 * @param {Number} [opts.offset]
 * @param {Number} [opts.limit]
 * @param {Boolean} [opts.reverse]
 * @param {Boolean} [opts.includeContent]
 * @param {Object} [permissions]
 * @param {EnumeratedSessionPerm[]} [permissions.query]
 * @returns {Promise<RecordDescription[]>}
 */
export async function search (q = '', opts, permissions) {
  var shouldExcludePrivate = checkShouldExcludePrivate(opts, permissions)

  var notificationRtimes
  if (opts?.notification) {
    notificationRtimes = await getNotificationsRtimes()
  }

  // prep search terms
  q = `"${q.replace(/["]/g, '""')}" *`

  var query = db('records_data_fts')
    .select(
      'origin',
      'path',
      'prefix',
      'extension',
      'ctime',
      'mtime',
      'rtime',
      'title as siteTitle',
      'records_data.record_rowid as record_rowid',
      'key',
      'rank',
      db.raw(`snippet(records_data_fts, 0, '<b>', '</b>', '...', 40) as matchingText`)
    )
    .innerJoin('records_data', 'records_data.rowid', 'records_data_fts.rowid')
    .innerJoin('records', 'records.rowid', 'records_data.record_rowid')
    .innerJoin('sites', 'sites.rowid', 'records.site_rowid')
    .whereIn('records_data.key', toStringArray(opts.field) || ['_content', 'title'])
    .whereRaw(`records_data_fts.value MATCH ?`, [q])
    .offset(opts?.offset || 0)
  if (typeof opts?.limit === 'number') {
    query = query.limit(opts.limit)
  }

  if (opts?.origin) {
    if (Array.isArray(opts.origin)) {
      let origins = opts.origin.map(origin => normalizeOrigin(origin))
      if (shouldExcludePrivate && origins.find(origin => origin === 'hyper://private')) {
        throw new PermissionsError()
      }
      query = query.whereIn('origin', origins)
    } else {
      let origin = normalizeOrigin(opts.origin)
      if (shouldExcludePrivate && origin === 'hyper://private') {
        throw new PermissionsError()
      }
      query = query.where({origin})
    }
  } else if (shouldExcludePrivate) {
    query = query.whereNot({origin: 'hyper://private'})
  }
  if (opts?.path) {
    if (Array.isArray(opts.path)) {
      query = query.where(function () {
        let chain = this.where(parseSimplePathSpec(opts.path[0]))
        for (let i = 1; i < opts.path.length; i++) {
          chain = chain.orWhere(parseSimplePathSpec(opts.path[i]))
        }
      })
    } else {
      query = query.where(parseSimplePathSpec(opts.path))
    }
  }

  if (opts?.notification) {
    query = query
      .select(
        'notification_key',
        'notification_subject_origin',
        'notification_subject_path',
      )
      .innerJoin('records_notification', 'records.rowid', 'records_notification.record_rowid')
    if (opts.notification.unread) {
      query = query.whereRaw(`rtime > ?`, [notificationRtimes.local_notifications_rtime])
    }
  }

  if (opts?.sort && ['ctime', 'mtime', 'rtime'].includes(opts.sort)) {
    query = query.orderBy(opts.sort, opts.reverse ? 'desc' : 'asc')
  } else {
    query = query.orderBy('rank', 'desc')
  }

  var hits = await query

  // merge hits on the same record
  var mergedHits = {}
  for (let hit of hits) {
    mergedHits[hit.record_rowid] = mergedHits[hit.record_rowid] || []
    mergedHits[hit.record_rowid].push(hit)
  }

  var results = await Promise.all(Object.values(mergedHits).map(async mergedHits => {
    var record = {
      type: 'file',
      path: mergedHits[0].path,
      url: mergedHits[0].origin + mergedHits[0].path,
      ctime: mergedHits[0].ctime,
      mtime: mergedHits[0].mtime,
      metadata: {},
      site: {
        url: mergedHits[0].origin,
        title: mergedHits[0].siteTitle || toNiceUrl(mergedHits[0].origin)
      },
      index: {
        id: 'local',
        rtime: mergedHits[0].rtime,
        links: [],
        matches: mergedHits.map(hit => ({
          key: hit.key === '_content' ? 'content' : hit.key,
          value: hit.matchingText
        }))
      },
      content: undefined,
      notification: undefined,
      // with multiple hits, we just take the best bm25() rank
      // this basically ignores multiple matching attrs as a signal
      // which is fine for now -prf
      rank: Math.max(...mergedHits.map(h => h.rank))
    }

    var rows = await db('records_data').select('*').where({record_rowid: mergedHits[0].record_rowid})
    for (let row of rows) {
      if (row.key === METADATA_KEYS.content) {
        if (opts?.includeContent) {
          record.content = row.value
        }
      } else if (row.key === METADATA_KEYS.link) {
        record.index.links.push(row.value)
      } else {
        record.metadata[row.key] = row.value
      }
    }

    if (opts?.notification) {
      record.notification = {
        key: mergedHits[0].notification_key,
        subject: joinPath(mergedHits[0].notification_subject_origin, mergedHits[0].notification_subject_path),
        unread: mergedHits[0].rtime > notificationRtimes.local_notifications_rtime
      }
    }

    return record
  }))

  // gotta resort due to our merge
  if (opts?.sort === 'ctime') {
    results.sort((a, b) => a.ctime - b.ctime)
  } else if (opts?.sort === 'mtime') {
    results.sort((a, b) => a.mtime - b.mtime)
  } else if (opts?.sort === 'rtime') {
    results.sort((a, b) => a.index.rtime - b.index.rtime)
  } else {
    results.sort((a, b) => a.rank > b.rank ? -1 : 1)
  }
  if (opts?.reverse) {
    results.reverse()
  }

  for (let result of results) {
    delete result.rank
  }
  
  return results
}

/**
 * @returns {Promise<void>}
 */
export async function clearNotifications () {
  var localRes = await local.query(db, {
    notification: true,
    limit: 1,
    sort: 'rtime',
    reverse: true
  })
  var lastLocalTs = localRes.records[0] ? localRes.records[0].index.rtime : Date.now()
  await db('indexer_state')
    .insert({key: 'local_notifications_rtime', value: lastLocalTs})
    .onConflictDoUpdate('key', {key: 'local_notifications_rtime', value: lastLocalTs})

  var networkRes = await hyperbees.query({
    notification: true,
    limit: 1,
    sort: 'rtime',
    reverse: true
  })
  var lastNetworkTs = networkRes.records[0] ? networkRes.records[0].index.rtime : Date.now()
  await db('indexer_state')
    .insert({key: 'network_notifications_rtime', value: lastNetworkTs})
    .onConflictDoUpdate('key', {key: 'network_notifications_rtime', value: lastNetworkTs})
}

export async function triggerSiteIndex (origin, {ifIndexingSite} = {ifIndexingSite: false}) {
  origin = normalizeOrigin(origin)
  var myOrigins = await listMyOrigins()
  if (ifIndexingSite) {
    let indexState = await getIndexState(db, origin)
    if (!indexState?.length) return
  }
  await indexSite(origin, myOrigins)
}

export async function triggerSiteDeindex (origin) {
  origin = normalizeOrigin(origin)
  await deindexSite(origin)
}

export function getState () {
  return state
}

export function createEventStream () {
  return emitStream(events)
}

// internal methods
// =

const DEBUGGING = {
  setStatus (task, nextRun) {
    state.status = {task, nextRun}
    events.emit('status-change', {task, nextRun})
  },
  
  setSiteState ({url, progress, last_indexed_version, last_indexed_ts, error}) {
    const siteState = {url, progress, last_indexed_version, last_indexed_ts, error}
    state.sites[url] = siteState
    events.emit('site-state-change', siteState)
  },
  
  setQueue (queue) {
    state.queue = queue.slice() // must slice because we're going to mutate this queue
    events.emit('queue-change', {queue})
  },
  
  moveToTargets (origin) {
    let i = state.queue.indexOf(origin)
    if (i === -1) return
    state.queue.splice(i, 1)
    state.targets.push(origin)
    events.emit('queue-change', {queue: state.queue})
    events.emit('targets-change', {targets: state.targets})
  },
  
  removeTarget (origin) {
    let i = state.targets.indexOf(origin)
    if (i === -1) return
    state.targets.splice(i, 1)
    events.emit('targets-change', {targets: state.targets})
  },
}

/**
 * @returns {Promise<void>}
 */
var _isFirstRun = undefined
async function tick () {
  DEBUGGING.setStatus('indexing')
  try {
    var myOrigins = await listMyOrigins()
    if (typeof _isFirstRun === 'undefined') {
      _isFirstRun = await getIsFirstRun(db)
    }

    var originsToIndex = await listOriginsToIndex(db)
    DEBUGGING.setQueue(originsToIndex)
    await parallel(originsToIndex, indexSite, myOrigins)

    if (_isFirstRun) {
      // immediately re-run now that we've populated with subscription records
      _isFirstRun = false
      originsToIndex = await listOriginsToIndex(db)
      await parallel(originsToIndex, indexSite, myOrigins)
    }

    DEBUGGING.setStatus('capturing metadata')
    var originsToCapture = await listOriginsToCapture()
    DEBUGGING.setQueue(originsToCapture)
    await parallel(originsToCapture, async (origin) => {
      try {
        DEBUGGING.moveToTargets(origin)
        await loadSite(db, origin) // this will capture the metadata of the site
      } catch {}
      DEBUGGING.removeTarget(origin)
    })

    DEBUGGING.setStatus('cleaning up')
    var originsToDeindex = await listOriginsToDeindex(db, originsToIndex)
    DEBUGGING.setQueue(originsToDeindex)
    await parallel(originsToDeindex, deindexSite)
  } finally {
    DEBUGGING.setStatus('waiting', Date.now() + TICK_INTERVAL)
    setTimeout(tick, TICK_INTERVAL)
  }
}

async function indexSite (origin, myOrigins) {
  origin = normalizeOrigin(origin)
  DEBUGGING.moveToTargets(origin)
  var release = await lock(`beaker-indexer:${origin}`)
  var current_version
  var isFirstIndex
  try {
    current_version = undefined
    let site = await loadSite(db, origin, {onIsFirstIndex: () => {
      isFirstIndex = true
      // optimistically indicate in the UI that sync is occurring
      // (we want to do this as quickly as possible to make things responsive)
      DEBUGGING.setSiteState({
        url: origin,
        progress: 0,
        last_indexed_version: 0,
        last_indexed_ts: Date.now(),
        error: undefined
      })
    }})
    if (!site.is_index_target) {
      // is now an index target
      await setSiteFlags(db, site, {is_index_target: true})
    }
    current_version = site.current_version
    if (site.current_version === site.last_indexed_version) {
      return
    }

    logger.silly(`Indexing ${origin} [ v${site.last_indexed_version} -> v${site.current_version} ]`)
    let updates = await site.listUpdates()
    logger.silly(`${updates.length} updates found for ${origin}`)
    if (updates.length === 0) {
      if (!site.is_indexed && site.last_indexed_version > 0) {
        // was indexed prior to site flags were introduced, correct the record
        await setSiteFlags(db, site, {is_indexed: true})
      }
      return
    }

    let progCurr = 0, progTotal = updates.length
    for (let update of updates) {
      DEBUGGING.setSiteState({
        url: site.origin,
        progress: Math.round(progCurr++ / progTotal * 100),
        last_indexed_version: site.current_version,
        last_indexed_ts: Date.now(),
        error: undefined
      })
      if (update.remove) {
        // file deletion
        let res = await db('records').select('rowid').where({
          site_rowid: site.rowid,
          path: update.path
        })
        if (res[0]) await db('records_data').del().where({record_rowid: res[0].rowid})
        res = await db('records').del().where({site_rowid: site.rowid, path: update.path})
        if (+res > 0) {
          logger.silly(`Deindexed ${site.origin}${update.path}`, {origin: site.origin, path: update.path})
        }
      } else {
        // file write
        let extension = extname(update.path)
        let prefix = dirname(update.path)
        let dataEntries = [
          /* records_data.key, records_data.value */
          ...Object.entries(update.metadata).map(([key, value]) => {
            return [key, value]
          })
        ]

        // read content if markdown
        let content, contentLinks
        if (extension === '.md') {
          content = await site.fetch(update.path)
          contentLinks = markdownLinkExtractor(content)
          contentLinks = Array.from(new Set(contentLinks)) // remove duplicates
          dataEntries.push([METADATA_KEYS.content, content])
          dataEntries = dataEntries.concat(contentLinks.map(url => ([METADATA_KEYS.link, url])))
        }

        // index the base record
        let rowid
        let isNew = true
        try {
          // NOTE
          // on the first indexing of a site, we're going to be syncing a backlog of content
          // this can create a bunch of needless notifications
          // so we allow the rtime to get 'backdated' to avoid that
          // -prf
          let rtime = isFirstIndex ? Math.min(+update.ctime, Date.now()) : Date.now()

          let res = await db('records').insert({
            site_rowid: site.rowid,
            path: update.path,
            prefix,
            extension,
            mtime: update.mtime,
            ctime: update.ctime,
            rtime
          })
          rowid = res[0]
        } catch (e) {
          // TODO can we check the error type for constraint violation?
          isNew = false
          let res = await db('records').select('rowid').where({
            site_rowid: site.rowid,
            path: update.path
          })
          rowid = res[0].rowid
          await db('records').update({
            mtime: update.mtime,
            ctime: update.ctime
          }).where({rowid})
        }

        // index the record's data
        if (!isNew) {
          await db('records_data').del().where({record_rowid: rowid})
        }
        await Promise.all(dataEntries
          .filter(([key, value]) => value !== null && typeof value !== 'undefined')
          .map(([key, value]) => {
            if (key !== METADATA_KEYS.content && isUrl(value)) value = normalizeUrl(value)
            return db('records_data').insert({record_rowid: rowid, key, value})
          })
        )

        // detect "notifications"
        for (let [key, value] of dataEntries) {
          if (key === METADATA_KEYS.content || !isUrl(value)) {
            continue
          }
          let subjectp = parseUrl(value, site.origin)
          if (!myOrigins.includes(site.origin) && myOrigins.includes(subjectp.origin)) {
            if (subjectp.origin === 'hyper://private') {
              // special case- if somebody publishes something linking to hyper://private,
              // it's a mistake which should be ingored
              // -prf
              continue
            }
            await db('records_notification').del().where({
              record_rowid: rowid,
              notification_key: key,
              notification_subject_origin: subjectp.origin,
              notification_subject_path: subjectp.path
            })
            await db('records_notification').insert({
              record_rowid: rowid,
              notification_key: key,
              notification_subject_origin: subjectp.origin,
              notification_subject_path: subjectp.path
            })
          }
        }
      }
    }
    DEBUGGING.setSiteState({
      url: site.origin,
      progress: undefined,
      last_indexed_version: site.current_version,
      last_indexed_ts: Date.now(),
      error: undefined
    })
    logger.debug(`Indexed ${origin} [ v${site.last_indexed_version} -> v${site.current_version} ]`)
    await updateIndexState(db, site)
    if (!site.is_indexed) {
      // indicate this site's index is now ready to be used
      await setSiteFlags(db, site, {is_indexed: true})
    }
  } catch (e) {
    DEBUGGING.setSiteState({
      url: origin,
      progress: undefined,
      last_indexed_version: current_version,
      last_indexed_ts: Date.now(),
      error: e.toString()
    })
    logger.debug(`Failed to index site ${origin}. ${e.toString()}`, {origin, error: e.toString()})
  } finally {
    DEBUGGING.removeTarget(origin)
    release()
  }
}

async function deindexSite (origin) {
  origin = normalizeOrigin(origin)
  DEBUGGING.moveToTargets(origin)
  var release = await lock(`beaker-indexer:${origin}`)
  try {
    let site = (await db('sites').select('rowid', 'origin').where({origin}))[0]
    if (!site) throw new Error(`Site not found in index`)
    let records = await db('records').select('rowid').where({site_rowid: site.rowid})
    for (let record of records) {
      await db('records_notification').del().where({record_rowid: record.rowid})
      await db('records_data').del().where({record_rowid: record.rowid})
    }
    await db('records').del().where({site_rowid: site.rowid})
    await db('sites').update({
      last_indexed_version: 0,
      last_indexed_ts: 0,
      is_index_target: 0, // no longer an indexing target
      is_indexed: 0 // no longer indexed
    }).where({origin})
    logger.debug(`Deindexed ${site.origin}/*`, {origin: site.origin})
  } catch (e) {
    logger.debug(`Failed to de-index site ${origin}. ${e.toString()}`, {origin, error: e.toString()})
  } finally {
    DEBUGGING.removeTarget(origin)
    release()
  }
}

/**
 * @param {String} [url]
 * @returns {Promise<RecordDescription>}
 */
async function getLiveRecord (url) {
  let urlp = parseUrl(url)
  if (!urlp.origin.startsWith('hyper:')) {
    return undefined // hyper only for now
  }
  try {
    let site = await loadSite(db, urlp.origin)
    let stat = await site.stat(urlp.pathname)
    let update = {
      remove: false,
      path: urlp.pathname,
      metadata: stat.metadata,
      ctime: stat.ctime,
      mtime: stat.mtime
    }
    logger.silly(`Live-fetching ${url}`)
    var record = {
      type: 'file',
      path: urlp.pathname,
      url,
      ctime: +stat.ctime,
      mtime: +stat.mtime,
      metadata: {},
      index: {
        id: 'live',
        rtime: Date.now(),
        links: []
      },
      site: {
        url: site.origin,
        title: site.title || toNiceUrl(urlp.origin)
      },
      content: undefined,
      notification: undefined
    }
    for (let k in stat.metadata) {
      record.metadata[k] = stat.metadata[k]
    }
    if (record.path.endsWith('.md')) {
      record.content = await site.fetch(update.path)
      record.index.links = markdownLinkExtractor(record.content)
    }
    return record
  } catch (e) {
    logger.debug(`Failed to live-fetch file ${url}. ${e.toString()}`, {origin: urlp.origin, error: e.toString()})
  }  
  return undefined
}

/**
 * @param {Object} [opts]
 * @param {String|Array<String>} [opts.path]
 * @returns {Promise<RecordDescription[]>}
 */
async function listLiveRecords (origin, opts) {
  var records = []
  try {
    let site = await loadSite(db, origin)
    logger.silly(`Live-querying ${origin}`)
    let files = await site.listMatchingFiles(opts.path)
    records = records.concat(files.map(file => {
      return {
        type: 'file',
        path: file.path,
        url: file.url,
        ctime: +file.stat.ctime,
        mtime: +file.stat.mtime,
        metadata: file.stat.metadata,
        index: {
          id: 'live',
          rtime: Date.now(),
          links: []
        },
        site: {
          url: site.origin,
          title: site.title || toNiceUrl(site.origin)
        },
        content: undefined,
        notification: undefined,

        // helper to fetch the rest of the data if in the results set
        fetchData: async function () {
          if (this.path.endsWith('.md')) {
            this.content = await site.fetch(file.path)
            this.index.links = markdownLinkExtractor(this.content)
          }
        }
      }
    }))
  } catch (e) {
    logger.debug(`Failed to live-query site ${origin}. ${e.toString()}`, {origin, error: e.toString()})
  }  
  return records
}

/**
 * @returns {Promise<{local_notifications_rtime: Number, network_notifications_rtime: Number}>}
 */
async function getNotificationsRtimes () {
  var [localRows, networkRows] = await Promise.all([
    db('indexer_state').select('value').where({key: 'local_notifications_rtime'}),
    db('indexer_state').select('value').where({key: 'network_notifications_rtime'})
  ])
  return {
    local_notifications_rtime: localRows[0]?.value ? (+localRows[0]?.value) : 0,
    network_notifications_rtime: networkRows[0]?.value ? (+networkRows[0]?.value) : 0
  }
}

/**
 * @param {String} targetOrigin 
 * @returns {Promise<SiteDescriptionGraph>}
 */
async function getSiteGraph (targetOrigin) {
  if (targetOrigin === 'hyper://private') {
    // special case
    return {user: {isSubscriber: false, isSubscribedTo: false}, counts: {local: 0, network: 0}}
  }
  let userOrigin = normalizeOrigin(filesystem.getProfileUrl())
  const getUserSubset = async () => {
    let [isUserSubbed, isSubbedToUser] = await Promise.all([
      count({path: '/subscriptions/*.goto', origin: userOrigin, links: targetOrigin}),
      count({path: '/subscriptions/*.goto', origin: targetOrigin, links: userOrigin})
    ])
    return {
      isSubscriber: isUserSubbed > 0,
      isSubscribedTo: isSubbedToUser > 0
    }
  }
  let [user, localSubs] = await Promise.all([
    getUserSubset(),
    query({path: '/subscriptions/*.goto', links: targetOrigin, index: 'local'})
  ])
  let networkCount = await hyperbees.countSubscribers(targetOrigin, localSubs) // use the index that's more optimized for sub counts
  if (typeof networkCount === 'undefined') {
    // hyperbee is disabled by the user, just use the local count
    networkCount = localSubs.length
  }
  return {user, counts: {local: localSubs.length, network: networkCount}}
}

function toStringArray (v) {
  if (!v) return
  v = toArray(v).filter(item => typeof item === 'string')
  if (v.length === 0) return
  return v
}