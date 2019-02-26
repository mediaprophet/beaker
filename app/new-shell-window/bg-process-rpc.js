import * as rpc from 'pauls-electron-rpc'
import browserManifest from '@beaker/core/web-apis/manifests/internal/browser'
import bookmarksManifest from '@beaker/core/web-apis/manifests/internal/bookmarks'
import viewsManifest from '../background-process/rpc-manifests/views'

export const beakerBrowser = rpc.importAPI('beaker-browser', browserManifest)
export const bookmarks = rpc.importAPI('bookmarks', bookmarksManifest)
export const views = rpc.importAPI('background-process-views', viewsManifest)
