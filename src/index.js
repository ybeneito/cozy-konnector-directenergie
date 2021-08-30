process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://60c5bb56449a4d9bb5bff05b2449d0af@sentry.cozycloud.cc/122'

const {
  log,
  CookieKonnector,
  errors,
  scrape,
  utils
} = require('cozy-konnector-libs')
const moment = require('moment')
const cheerio = require('cheerio')

const CozyBrowser = require('cozy-konnector-libs/dist/libs/CozyBrowser')
const browser = new CozyBrowser({
  waitDuration: '5s'
})

browser.pipeline.addHandler(function(browser, request) {
  const blacklist = [
    'https://cdn.trustcommander.net/privacy/3466/privacy_v2_23.js',
    '2c54a23723a40d98a66f58f518388a3a'
  ]
  if (blacklist.some(url => request.url.includes(url))) {
    log('info', `ignore: ${request.url}`)
    return {
      status: 200,
      statusText: 'OK',
      url: request.url,
      _consume: async () => ''
    }
  }
})

class DirectConnector extends CookieKonnector {
  async testSession() {
    if (!this._jar._jar.toJSON().cookies.length) {
      return false
    }
    log('debug', 'Testing session')
    await browser.loadCookieJar(this._jar._jar)
    try {
      await browser.visit(
        'https://www.totalenergies.fr/clients/mon-compte/gerer-mes-comptes',
        {
          waitDuration: '5s'
        }
      )
    } catch (err) {
      log('debug', err.message)
      return false
    }

    if (
      browser.location.href.includes(
        'https://www.totalenergies.fr/clients/connexion'
      )
    ) {
      return false
    }

    await this.saveSession(browser)
    return true
  }

  async fetch(fields) {
    // As 09-2020, a captcha was display with an old and used cookie jar.
    // We so flush the jar each time now
    await this.resetSession()
    // This code is now useless (session always invalid), but kept in case of fallback.
    if (!(await this.testSession())) {
      await this.deactivateAutoSuccessfulLogin()
      await this.authenticate(fields)
      await this.notifySuccessfulLogin()
    }

    await this.selectActiveAccount()

    for (const type of ['electricite', 'gaz']) {
      const bills = await this.parseBills(type)

      if (bills && bills.length)
        await this.saveBills(bills, fields, {
          linkBankOperations: false,
          fileIdAttributes: ['vendorRef']
        })
    }
    this.saveSession()
    // I don't know why zombiejs keeps running even if all promises are resolved
    process.exit(0)
  }

  async authenticate(fields) {
    const { login, password } = await checkFields(fields)
    await browser.visit('https://www.totalenergies.fr/clients/connexion', {
      waitDuration: '5s'
    })
    log('debug', 'fill form')
    await browser.fill('#formz-authentification-form-login', login)
    await browser.fill('#formz-authentification-form-password', password)
    log('debug', 'submit form')
    await browser.pressButton('.fz-btn-validation')
    log('debug', 'save session')
    await this.saveSession(browser)

    // validate the resulting page
    const $ = cheerio.load(await browser.html())
    const alert = $('.cadre--alerte')

    if (alert.length > 0) {
      if (
        alert
          .text()
          .includes('Les informations renseignées ne correspondent pas')
      ) {
        throw new Error(errors.LOGIN_FAILED)
      }
    } else if (browser.location.href.includes('maintenance')) {
      log('error', `Got maintenance url: ${browser.location.href}`)
      throw new Error(errors.VENDOR_DOWN)
    }
    await browser.destroy()
    // validate: (statusCode, $, fullResponse) => {
    // }
    // })
  }

  async selectActiveAccount() {
    log('info', 'Selecting active account')
    const $ = await this.request(
      'https://www.totalenergies.fr/clients/mon-compte/gerer-mes-comptes'
    )

    const accounts = scrape(
      $,
      {
        label: {
          sel: 'input',
          attr: 'value'
        },
        isActive: {
          sel: '.text--exergue',
          fn: el => Boolean($(el).length)
        },
        refClient: {
          sel: 'input',
          attr: 'data-partenaire-id'
        },
        address: {
          sel: '.row > .columns:nth-child(2)',
          fn: $ =>
            $.html()
              .split('<br>')
              .slice(1, 2)
              .join(' ')
              .split('<div')[0]
              .trim()
        },
        link: {
          sel: 'div',
          fn: $ => {
            let link = $.closest('.cadre')
              .next('.cadre')
              .find('a')
              .attr('href')
            if (link) link = 'https://www.totalenergies.fr' + link
            return link
          }
        }
      },
      '.page > .row >  div > .cadre[data-cs-mask]'
    )

    const activeAccounts = accounts.filter(account => account.isActive)
    if (activeAccounts.length === 0 && accounts.length > 0) {
      log(
        'error',
        `Found no active account but there are ${accounts.length} accounts in total`
      )
      throw new Error('USER_ACTION_NEEDED.ACCOUNT_REMOVED')
    }

    if (!activeAccounts[0] && $('#formz-authentification-form-login').length) {
      log('error', 'Still a login form')
      throw new Error(errors.VENDOR_DOWN)
    }
    const href = activeAccounts[0].link

    log('debug', "Going to the active account's page if needed.")
    if (href) {
      await this.request(href)
    }
  }

  async parseBills(type) {
    log('debug', 'Parsing bills')
    let $
    try {
      $ = await this.request(
        `https://www.totalenergies.fr/clients/mes-factures/mes-factures-${type}/mon-historique-de-factures`
      )
    } catch (err) {
      log('debug', err.message.substring(0, 60))
      log('debug', `found no ${type} bills on this account`)
      return []
    }

    const docs = scrape(
      $,
      {
        label: {
          sel: '.detail-facture__label strong'
        },
        vendorRef: {
          sel: '.text--body',
          parse: ref => ref.match(/^N° (.*)$/).pop()
        },
        date: {
          sel: '.detail-facture__date',
          parse: date => moment(date, 'DD/MM/YYYY').toDate()
        },
        status: {
          sel: '.detail-facture__statut'
        },
        amount: {
          sel: '.detail-facture__montant',
          parse: normalizeAmount
        },
        isEcheancier: {
          sel: '.detail-facture__action.btn-bas-nivo2',
          attr: 'class',
          parse: Boolean
        },
        fileurl: {
          sel: '.btn--telecharger',
          attr: 'href'
        },
        subBills: {
          sel: 'span:nth-child(1)',
          fn: el => {
            const $details = $(el)
              .closest('.detail-facture')
              .next()

            if ($details.hasClass('action__display-zone')) {
              const fileurl = $details.find('.btn--telecharger').attr('href')
              return Array.from($details.find('tbody tr'))
                .map(el => {
                  let date = $(el)
                    .find('td:nth-child(4)')
                    .text()
                    .match(/Payée le (.*)/)
                  if (date) date = moment(date.slice(1), 'DD/MM/YYYY').toDate()
                  return {
                    amount: normalizeAmount(
                      $(el)
                        .find('td:nth-child(2)')
                        .text()
                    ),
                    date,
                    fileurl
                  }
                })
                .filter(bill => bill.date)
            }

            return false
          }
        }
      },
      '.detail-facture'
    ).filter(bill => !(bill.amount === false && bill.isEcheancier === false))

    const bills = []

    for (const doc of docs) {
      if (doc.subBills) {
        for (const subBill of doc.subBills) {
          const { vendorRef, label } = doc
          const echDate = doc.date
          const { amount, date, fileurl } = subBill
          bills.push({
            vendorRef,
            label,
            amount,
            date,
            type,
            fileurl: `https://www.totalenergies.fr${fileurl}`,
            filename: `echeancier_${
              type === 'electricite' ? 'elec' : type
            }_${moment(echDate).format('YYYYMMDD')}_directenergie.pdf`,
            vendor: 'Direct Energie',
            fileAttributes: {
              metadata: {
                carbonCopy: true
              }
            }
          })
        }
      } else {
        const { vendorRef, label, date, fileurl, amount, status } = doc
        const isRefund = status.includes('Remboursée')
        bills.push({
          vendorRef,
          label,
          amount,
          date,
          isRefund,
          fileurl: `https://www.totalenergies.fr${fileurl}`,
          filename: `${utils.formatDate(date)}_directenergie_${amount.toFixed(
            2
          )}EUR${vendorRef}.pdf`,
          fileIdAttributes: ['vendorRef'],
          vendor: 'Direct Energie',
          fileAttributes: {
            metadata: {
              carbonCopy: true
            }
          }
        })
      }
    }

    log('info', `found ${bills.length} bills`)

    return bills
  }
}

const connector = new DirectConnector({
  // debug: true,
  cheerio: true,
  json: false
})

connector.run()

const checkFields = fields => {
  log('Checking the presence of the login and password')
  if (fields.login === undefined) {
    throw new Error('Login is missing')
  }
  if (fields.password === undefined) {
    throw new Error('Password is missing')
  }
  return Promise.resolve({
    login: fields.login.trim(),
    password: fields.password
  })
}

const normalizeAmount = amount => {
  // Ignore echeancier
  if (amount.includes('/')) return false
  return parseFloat(
    amount
      .replace('€', '')
      .replace(',', '.')
      .trim()
  )
}
