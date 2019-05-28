// @flow
import Web3 from 'web3'
import { default as PromiEvent } from 'web3-core-promievent'
import HDWalletProvider from 'truffle-hdwallet-provider'
import type { WebSocketProvider } from 'web3-providers-ws'
import type { HttpProvider } from 'web3-providers-http'
import IdentityABI from '@gooddollar/goodcontracts/build/contracts/Identity.json'
import RedemptionABI from '@gooddollar/goodcontracts/build/contracts/RedemptionFunctional.json'
import GoodDollarABI from '@gooddollar/goodcontracts/build/contracts/GoodDollar.json'
import ReserveABI from '@gooddollar/goodcontracts/build/contracts/GoodDollarReserve.json'
import ContractsAddress from '@gooddollar/goodcontracts/releases/deployment.json'
import conf from '../server.config'
import logger from '../../imports/pino-logger'
import { type TransactionReceipt } from './blockchain-types'
import moment from 'moment'
import get from 'lodash/get'

const log = logger.child({ from: 'AdminWallet' })
export class Wallet {
  web3: Web3

  wallet: HDWalletProvider

  accountsContract: Web3.eth.Contract

  tokenContract: Web3.eth.Contract

  identityContract: Web3.eth.Contract

  claimContract: Web3.eth.Contract

  reserveContract: Web3.eth.Contract

  address: string

  networkId: number

  mnemonic: string

  constructor(mnemonic: string) {
    this.mnemonic = mnemonic
    this.init()
  }

  getWeb3TransportProvider(): HttpProvider | WebSocketProvider {
    let provider
    let web3Provider
    let transport = conf.ethereum.web3Transport
    switch (transport) {
      case 'WebSocket':
        provider = conf.ethereum.websocketWeb3Provider
        web3Provider = new Web3.providers.WebsocketProvider(provider)
        break

      case 'HttpProvider':
        provider = conf.ethereum.httpWeb3Provider + conf.infuraKey
        web3Provider = new Web3.providers.HttpProvider(provider)
        break

      default:
        provider = conf.ethereum.httpWeb3Provider + conf.infuraKey
        web3Provider = new Web3.providers.HttpProvider(provider)
        break
    }
    log.debug({ conf, web3Provider, provider })

    return web3Provider
  }

  async init() {
    log.debug('Initializing wallet:', { conf: conf.ethereum })

    if (conf.privateKey) {
      this.web3 = new Web3(this.getWeb3TransportProvider(), null, {
        defaultGasPrice: Web3.utils.toWei('1', 'gwei'),
        defaultGas: 500000
      })
      let account = this.web3.eth.accounts.privateKeyToAccount(conf.privateKey)
      this.web3.eth.accounts.wallet.add(account)
      this.web3.eth.defaultAccount = account.address
      this.address = account.address
      log.debug('Initialized by private key:', account.address)
    } else if (conf.mnemonic) {
      this.wallet = new HDWalletProvider(this.mnemonic, this.getWeb3TransportProvider(), 0, 10)

      this.web3 = new Web3(this.wallet, null, {
        defaultAccount: this.address,
        defaultGasPrice: Web3.utils.toWei('1', 'gwei'),
        defaultGas: 500000
      })
      this.address = this.wallet.addresses[0]
      let account = this.web3.eth.accounts.privateKeyToAccount(
        '0x' + this.wallet.wallets[this.address]._privKey.toString('hex')
      )
      this.web3.eth.accounts.wallet.add(account)
    }
    this.network = conf.network
    this.networkId = conf.ethereum.network_id
    this.identityContract = new this.web3.eth.Contract(
      IdentityABI.abi,
      get(ContractsAddress, `${this.network}.Identity`, IdentityABI.networks[this.networkId].address),
      {
        from: this.address,
        gas: 500000,
        gasPrice: Web3.utils.toWei('1', 'gwei')
      }
    )
    this.claimContract = new this.web3.eth.Contract(
      RedemptionABI.abi,
      get(ContractsAddress, `${this.network}.RedemptionFunctional`, RedemptionABI.networks[this.networkId].address),
      {
        from: this.address,
        gas: 500000,
        gasPrice: Web3.utils.toWei('1', 'gwei')
      }
    )
    this.tokenContract = new this.web3.eth.Contract(
      GoodDollarABI.abi,
      get(ContractsAddress, `${this.network}.GoodDollar`, GoodDollarABI.networks[this.networkId].address),
      {
        from: this.address,
        gas: 500000,
        gasPrice: Web3.utils.toWei('1', 'gwei')
      }
    )
    this.reserveContract = new this.web3.eth.Contract(
      ReserveABI.abi,
      get(ContractsAddress, `${this.network}.GoodDollarReserve`, ReserveABI.networks[this.networkId].address),
      {
        from: this.address,
        gas: 500000,
        gasPrice: Web3.utils.toWei('1', 'gwei')
      }
    )
    try {
      let gdbalance = await this.tokenContract.methods.balanceOf(this.address).call()
      let nativebalance = await this.web3.eth.getBalance(this.address)
      log.debug('AdminWallet Ready:', { account: this.address, gdbalance, nativebalance })
    } catch (e) {
      log.error('Error initializing wallet', e)
    }
  }

  async whitelistUser(address: string, did: string): Promise<TransactionReceipt> {
    const tx: TransactionReceipt = await this.identityContract.methods
      .whiteListUser(address, did)
      .send()
      .catch(e => {
        log.error('Error whitelistUser', e)
        throw e
      })
    log.info('Whitelisted user', { address, did, tx })
    return tx
  }

  async blacklistUser(address: string): Promise<TransactionReceipt> {
    const tx: TransactionReceipt = await this.identityContract.methods
      .blackListUser(address)
      .send()
      .catch(e => {
        log.error('Error blackListUser', e)
        throw e
      })

    return tx
  }

  async isVerified(address: string): Promise<boolean> {
    const tx: boolean = await this.identityContract.methods
      .isWhitelisted(address)
      .call()
      .catch(e => {
        log.error('Error isVerified', e.message)
        throw e
      })
    return tx
  }

  async topWallet(
    address: string,
    lastTopping?: moment.Moment = moment().subtract(1, 'day'),
    force: boolean = false
  ): PromiEvent<TransactionReceipt> {
    let daysAgo = moment().diff(moment(lastTopping), 'days')
    if (conf.env !== 'development' && daysAgo < 1) throw new Error('Daily limit reached')
    try {
      const isVerified = force || (await this.isVerified(address))
      if (isVerified) {
        let userBalance = await this.web3.eth.getBalance(address)
        let toTop = parseInt(Web3.utils.toWei('1000000', 'gwei')) - userBalance
        log.debug('TopWallet:', { userBalance, toTop })
        if (toTop / 1000000 >= 0.75)
          return this.web3.eth.sendTransaction({
            from: this.address,
            to: address,
            value: toTop,
            gas: 100000,
            gasPrice: Web3.utils.toWei('1', 'gwei')
          })
        throw new Error("User doesn't need topping")
      } else throw new Error(`User not verified: ${address} ${isVerified}`)
    } catch (e) {
      log.error('Error topWallet', e)
      throw e
    }
  }

  async getAddressBalance(address: string): Promise<number> {
    return this.web3.eth.getBalance(address)
  }

  async getBalance(): Promise<number> {
    return this.web3.eth
      .getBalance(this.address)
      .then(b => Web3.utils.fromWei(b))
      .catch(e => {
        log.error('Error getBalance', e)
        throw e
      })
  }
}

const AdminWallet = new Wallet(conf.mnemonic)
export default AdminWallet
