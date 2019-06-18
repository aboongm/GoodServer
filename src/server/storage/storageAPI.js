// @flow
import { Router } from 'express'
import passport from 'passport'
import get from 'lodash/get'
import { type StorageAPI, UserRecord } from '../../imports/types'
import { wrapAsync } from '../utils/helpers'
import { defaults } from 'lodash'

import { Mautic } from '../mautic/mauticAPI'
import conf from '../server.config'
import AdminWallet from '../blockchain/AdminWallet'
import Helper from '../verification/faceRecognition/faceRecognitionHelper'

const setup = (app: Router, storage: StorageAPI) => {
  /**
   * @api {post} /user/add Add user account
   * @apiName Add
   * @apiGroup Storage
   *
   * @apiParam {Object} user
   *
   * @apiSuccess {Number} ok
   * @ignore
   */
  app.post(
    '/user/add',
    passport.authenticate('jwt', { session: false }),
    wrapAsync(async (req, res, next) => {
      const { body, user: userRecord, log } = req
      const logger = req.log.child({ from: 'storageAPI - /user/add' })

      //check that user passed all min requirements
      if (
        ['production', 'staging'].includes(conf.env) &&
        (userRecord.smsValidated !== true ||
          (conf.skipEmailVerification === false && userRecord.isEmailConfirmed !== true))
      )
        throw new Error('User email or mobile not verified!')

      const user: UserRecord = defaults(body.user, { identifier: userRecord.loggedInAs })
      //mautic contact should already exists since it is first created during the email verification we update it here
      const mauticRecord = process.env.NODE_ENV === 'development' ? {} : await Mautic.createContact(user).catch(e => {})
      logger.debug('User mautic record', { mauticRecord })
      //topwallet of user after registration
      storage.updateUser({ ...user, mauticId: get(mauticRecord, 'contact.fields.all.id', -1) })
      let ok = await AdminWallet.topWallet(userRecord.gdAddress, null, true)
        .then(r => ({ ok: 1 }))
        .catch(e => {
          logger.error('New user topping failed', e.message)
          return { ok: 0, error: 'New user topping failed' }
        })
      log.debug('added new user:', { user, ok })
      res.json(ok)
    })
  )

  /**
   * @api {post} /user/delete Delete user account
   * @apiName Delete
   * @apiGroup Storage
   *
   * @apiParam {String} zoomId
   *
   * @apiSuccess {Number} ok
   * @apiSuccess {[Object]} results
   * @ignore
   */
  app.post(
    '/user/delete',
    passport.authenticate('jwt', { session: false }),
    wrapAsync(async (req, res, next) => {
      const { body, user, log } = req
      log.info('deleteing user', { user })
      const results = await Promise.all([
        Helper.delete(body.zoomId)
          .then(r => ({ zoom: 'ok' }))
          .catch(e => ({ zoom: 'failed' })),
        (user.identifier ? storage.deleteUser(user) : Promise.resolve())
          .then(r => ({ gundb: 'ok' }))
          .catch(e => ({ gundb: 'failed' })),
        Mautic.deleteContact(user)
          .then(r => ({ mautic: 'ok' }))
          .catch(e => ({ mautic: 'failed' }))
      ])
      res.json({ ok: 1, results })
    })
  )
}
export default setup
