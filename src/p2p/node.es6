/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Engine } from '../engine'

const { inspect } = require('util')

const PeerInfo = require('peer-info')
const waterfall = require('async/waterfall')
// const multiaddr = require('multiaddr')
const pull = require('pull-stream')
// const { uniqBy } = require('ramda')

const debug = require('debug')('bcnode:p2p:node')
const { config } = require('../config')
// const { toObject } = require('../helper/debug')
const { getVersion } = require('../helper/version')
const logging = require('../logger')

const { BcBlock } = require('../protos/core_pb')
const { ManagedPeerBook } = require('./book')
const Bundle = require('./bundle').default
const Signaling = require('./signaling').websocket
const { PeerManager, DATETIME_STARTED_AT, QUORUM_SIZE } = require('./manager/manager')
// const { validateBlockSequence } = require('../bc/validation')
const { Multiverse } = require('../bc/multiverse')
const { BlockPool } = require('../bc/blockpool')
// const { blockByTotalDistanceSorter } = require('../engine/helper')

const { PROTOCOL_PREFIX, NETWORK_ID } = require('./protocol/version')

// const { PEER_QUORUM_SIZE } = require('./quorum')

export class PeerNode {
  _logger: Object // eslint-disable-line no-undef
  _engine: Engine // eslint-disable-line no-undef
  _interval: IntervalID // eslint-disable-line no-undef
  _bundle: Bundle // eslint-disable-line no-undef
  _manager: PeerManager // eslint-disable-line no-undef
  _peer: PeerInfo // eslint-disable-line no-undef
  _multiverse: Multiverse
  _blockPool: BlockPool

  constructor (engine: Engine) {
    this._engine = engine
    this._multiverse = new Multiverse(engine.persistence) /// !important this is a (nonselective) multiverse
    this._blockPool = new BlockPool(engine.persistence, engine._pubsub)
    this._logger = logging.getLogger(__filename)
    this._manager = new PeerManager(this)

    if (config.p2p.stats.enabled) {
      this._interval = setInterval(() => {
        debug(`Peers count ${this.manager.peerBookConnected.getPeersCount()}`)
      }, config.p2p.stats.interval * 1000)
    }
  }

  get bundle (): Bundle {
    return this._bundle
  }

  get manager (): PeerManager {
    return this._manager
  }

  get peer (): PeerInfo {
    return this._peer
  }

  get peerBook (): ManagedPeerBook {
    return this.manager.peerBook
  }

  get reportSyncPeriod (): Function {
    return this._engine.receiveSyncPeriod
  }

  get blockpool (): BlockPool {
    return this._blockPool
  }

  get multiverse (): Multiverse {
    return this._multiverse
  }

  set multiverse (multiverse: Multiverse) {
    this._multiverse = multiverse
  }

  _pipelineStartNode () {
    debug('_pipelineStartNode')

    return [
      // Create PeerInfo for local node
      (cb: Function) => {
        this._logger.info('Generating peer info')
        PeerInfo.create(cb)
      },

      // Join p2p network
      (peerInfo: PeerInfo, cb: Function) => {
        const peerId = peerInfo.id.toB58String()
        this._logger.info(`Registering addresses for ${peerId}`)

        // peerInfo.multiaddrs.add(multiaddr('/p2p-websocket-star'))

        // peerInfo.multiaddrs.add(Signaling.getAddress(peerInfo))
        peerInfo.multiaddrs.add(`/ip4/0.0.0.0/tcp/0/ipfs/${peerId}`)
        peerInfo.multiaddrs.add(`/ip6/::1/tcp/0/ipfs/${peerId}`)

        peerInfo.meta = {
          p2p: {
            networkId: NETWORK_ID
          },
          ts: {
            connectedAt: DATETIME_STARTED_AT,
            startedAt: DATETIME_STARTED_AT
          },
          version: {
            protocol: PROTOCOL_PREFIX,
            ...getVersion()
          }
        }
        this._peer = peerInfo

        cb(null, peerInfo)
      },

      // Create node
      (peerInfo: PeerInfo, cb: Function) => {
        this._logger.info('Creating P2P node')
        const opts = {
          signaling: Signaling.initialize(peerInfo),
          relay: false
        }
        this._bundle = new Bundle(peerInfo, this.peerBook, opts)

        cb(null, this._bundle)
      },

      // Start node
      (bundle: Object, cb: Function) => {
        this._logger.info('Starting P2P node')

        bundle.start((err) => {
          if (err) {
            this._logger.error(err)
          }
          cb(err, bundle)
        })
      },

      // Register event handlers
      (bundle: Object, cb: Function) => {
        this._logger.info('Registering event handlers')

        this.bundle.on('peer:discovery', (peer) => {
          return this.manager.onPeerDiscovery(peer).then(() => {
            if (this._shouldStopDiscovery()) {
              debug(`peer:discovery - Quorum of ${QUORUM_SIZE} reached, if testnet stopping discovery`)
              // return Promise.resolve(true)
              return this.stopDiscovery()
            }
          })
        })

        this.bundle.on('peer:connect', (peer) => {
          return this.manager.onPeerConnect(peer)
            .then((header) => {
              if (header !== undefined && header.getHeight !== undefined) {
                const highestBlock = this.engine.multiverse.getHighestBlock()
                if (highestBlock !== undefined) {
                  if (header.getHeight() + 2 < highestBlock.getHeight()) {
                    this.sendBlockToPeer(highestBlock, peer.id.toB58String())
                  }
                }
              }
            })
            .catch((err) => {
              this._logger.error(err)
              return this.manager.onPeerDisconnect(peer).then(() => {
                if (this._shouldStartDiscovery()) {
                  debug(`peer:disconnect - Quorum of ${QUORUM_SIZE} not reached, starting discovery`)
                  return this.startDiscovery()
                }
              })
            })
        })

        this.bundle.on('peer:disconnect', (peer) => {
          return this.manager.onPeerDisconnect(peer).then(() => {
            if (this._shouldStartDiscovery()) {
              debug(`peer:disconnect - Quorum of ${QUORUM_SIZE} not reached, starting discovery`)
              return this.startDiscovery()
            }
          })
        })

        cb(null)
      },

      // Register protocols
      (cb: Function) => {
        this._logger.info('Registering protocols')
        this.manager.registerProtocols(this.bundle)
        cb(null)
      }
    ]
  }

  start () {
    waterfall(this._pipelineStartNode(), (err) => {
      if (err) {
        this._logger.error(err)
        throw err
      }

      this._logger.info('P2P node started')
    })

    return true
  }

  /**
   *  Start (all) discovery services
   *
   * @returns {Promise}
   */
  startDiscovery (): Promise<bool> {
    debug('startDiscovery()')

    if (!this.bundle) {
      return Promise.resolve(false)
    }

    return this.bundle.startDiscovery()
  }

  /**
   * Stop (all) discovery services
   *
   * @returns {Promise}
   */
  stopDiscovery (): Promise<bool> {
    debug('stopDiscovery()')

    if (!this.bundle) {
      return Promise.resolve(false)
    }

    return this.bundle.stopDiscovery()
  }

  /**
   * Should be discovery started?
   *
   * - Is bundle initialized?
   * - Is discovery already started?
   * - Is the quorum not reached yet?
   *
   * @returns {boolean}
   * @private
   */
  _shouldStartDiscovery (): bool {
    debug('_shouldStartDiscovery()')

    // Check if bundle is initialized and discovery is enabled
    const bundle = this.bundle
    if (!bundle || bundle.discoveryEnabled) {
      debug('_shouldStartDiscovery() - discovery enabled')
      return false
    }

    // Check if manager is initialized
    const manager = this.manager
    if (!manager) {
      debug('_shouldStartDiscovery() - manager null')
      return false
    }

    return !manager.hasQuorum
  }

  /**
   * Should be discovery stopped?
   *
   * - Is bundle initialized?
   * - Is discovery already stopped?
   * - Is the quorum reached already?
   *
   * @returns {*}
   * @private
   */
  _shouldStopDiscovery (): bool {
    debug('_shouldStopDiscovery()')

    // Check if bundle is initialized and discovery is enabled
    const bundle = this.bundle
    if (!bundle || !bundle.discoveryEnabled) {
      return false
    }

    // Check if manager is initialized
    const manager = this.manager
    if (!manager) {
      return false
    }

    return manager.hasQuorum
  }

  sendBlockToPeer (block: BcBlock, peerId: string) {
    this._logger.debug(`Broadcasting msg to peers, ${inspect(block.toObject())}`)

    const url = `${PROTOCOL_PREFIX}/newblock`
    this.manager.peerBookConnected.getAllArray().map(peer => {
      this._logger.debug(`Sending to peer ${peer}`)
      if (peerId === peer.id.toB58String()) {
        this.bundle.dialProtocol(peer, url, (err, conn) => {
          if (err) {
            this._logger.error('Error sending message to peer', peer.id.toB58String(), err)
            this._logger.error(err)
            return err
          }
          // TODO JSON.stringify?
          pull(pull.values([block.serializeBinary()]), conn)
        })
      }
    })
  }

  broadcastNewBlock (block: BcBlock, withoutPeerId: ?string) {
    this._logger.debug(`Broadcasting msg to peers, ${inspect(block.toObject())}`)

    // this.bundle.pubsub.publish('newBlock', Buffer.from(JSON.stringify(block.toObject())), () => {})
    const url = `${PROTOCOL_PREFIX}/newblock`
    this.manager.peerBookConnected.getAllArray().map(peer => {
      this._logger.debug(`Sending to peer ${peer}`)
      const peerId = peer.id.toB58String()
      if (withoutPeerId === undefined || peerId !== withoutPeerId) {
        this.bundle.dialProtocol(peer, url, (err, conn) => {
          if (err) {
            this._logger.error('Error sending message to peer', peer.id.toB58String(), err)
            this._logger.error(err)
            return err
          }

          // TODO JSON.stringify?
          pull(pull.values([block.serializeBinary()]), conn)
        })
      }
    })
  }

  // get the best multiverse from all peers
  triggerBlockSync () {
    // const peerMultiverses = []
    // Notify miner to stop mining
    this.reportSyncPeriod(true)

    this.manager.peerBookConnected.getAllArray().map(peer => {
      this.reportSyncPeriod(true)
      this.manager.createPeer(peer)
        .getMultiverse()
        .then((multiverse) => {
          debug('Got multiverse from peer', peer.id.toB58String())
          // peerMultiverses.push(multiverse)

          // if (peerMultiverses.length >= PEER_QUORUM_SIZE) {
          //  const candidates = peerMultiverses.reduce((acc: Array<Object>, peerMultiverse) => {
          //    if (peerMultiverse.length > 0 && validateBlockSequence(peerMultiverse)) {
          //      acc.push(peerMultiverse)
          //    }

          //    return acc
          //  }, [])

          //  if (candidates.length >= PEER_QUORUM_SIZE) {
          //    const uniqueCandidates = uniqBy((candidate) => candidate[0].getHash(), candidates)
          //    if (uniqueCandidates.length === 1) {
          //      // TODO: Commit as active multiverse and begin full sync from known peers
          //    } else {
          //      const peerMultiverseByDifficultySum = uniqueCandidates
          //        .map(peerBlocks => peerBlocks[0])
          //        .sort(blockByTotalDistanceSorter)

          //      const winningMultiverse = peerMultiverseByDifficultySum[0]
          //      // TODO split the work among multiple correct candidates
          //      // const syncCandidates = candidates.filter((candidate) => {
          //      //   if (winner.getHash() === candidate[0].getHash()) {
          //      //     return true
          //      //   }
          //      //   return false
          //      // })
          //      const lowestBlock = this.multiverse.getLowestBlock()
          //      // TODO handle winningMultiverse[0] === undefined, see sentry BCNODE-6F
          //      if (lowestBlock && lowestBlock.getHash() !== winningMultiverse[0].getHash()) {
          //        this._blockPool.maximumHeight = lowestBlock.getHeight()
          //        // insert into the multiverse
          //        winningMultiverse.map(block => this.multiverse.addNextBlock(block))
          //        // TODO: Use RXP
          //        // Report not syncing
          //        this.reportSyncPeriod(false)
          //      }
          //    }
          //  }
          // }
        })
    })
  }
}

export default PeerNode
