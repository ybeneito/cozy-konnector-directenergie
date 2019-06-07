process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://60c5bb56449a4d9bb5bff05b2449d0af@sentry.cozycloud.cc/122'

const {
  log,
  BaseKonnector,
  requestFactory,
  saveBills,
  errors,
  scrape,
  utils
} = require('cozy-konnector-libs')
const moment = require('moment')
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const checkFields = fields => {
  log('Checking the presence of the login and password')
  if (fields.login === undefined) {
    throw new Error('Login is missing')
  }
  if (fields.password === undefined) {
    throw new Error('Password is missing')
  }
  return Promise.resolve({
    login: fields.login,
    password: fields.password
  })
}

const doLogin = (login, password) => {
  log('info', 'Logging in')
  return request({
    method: 'POST',
    url:
      'https://clients-total.direct-energie.com/connexion-clients-particuliers/',
    form: {
      'tx_deauthentification[login]': login,
      'tx_deauthentification[password]': password,
      'tx_deauthentification[form_valid]': '1',
      'tx_deauthentification[redirect_url]': '',
      'tx_deauthentification[mdp_oublie]': 'Je+me+connecte'
    }
  })
}

const checkLoginOk = $ => {
  if ($('.formlabel-left.error').length > 0) {
    throw new Error(errors.LOGIN_FAILED)
  }
  return $
}

const selectActiveAccount = async () => {
  log('info', 'Selecting active account')
  const $ = await request(
    'https://clients-total.direct-energie.com/mon-compte/gerer-mes-comptes'
  )
  const accounts = scrape(
    $,
    {
      label: {
        sel: 'h3.js-saisie_nom_compte input',
        attr: 'value'
      },
      isActive: {
        sel: '.compte-actif',
        fn: el => Boolean($(el).length)
      },
      refClient: {
        sel: '.liste_infos_yoom > .row:nth-child(1) > div:nth-child(2)'
      },
      address: {
        sel: '.liste_infos_yoom > .row:nth-child(3) > div:nth-child(2)'
      },
      link: {
        sel: 'a.btn-round',
        attr: 'href',
        parse: href => 'https://clients-total.direct-energie.com/' + href
      }
    },
    '.ec_rattacher_compte__compte'
  )

  const activeAccounts = accounts.filter(account => account.isActive)
  if (activeAccounts.length === 0) {
    log(
      'error',
      `Found no active account but there are ${
        accounts.length
      } accounts in total`
    )
    throw new Error('USER_ACTION_NEEDED.ACCOUNT_REMOVED')
  }

  const href = activeAccounts[0].link

  log('info', "Going to the active account's page.")

  return request(href)
}

const normalizeAmount = amount => {
  // ignore echeancier
  if (amount.includes('/')) return false
  return parseFloat(
    amount
      .replace('€', '')
      .replace(',', '.')
      .trim()
  )
}

const parseBills = async type => {
  log('info', 'Parsing bills')
  let $
  try {
    $ = await request(
      `https://total.direct-energie.com/clients/mes-factures/mes-factures-${type}/mon-historique-de-factures`
    )
  } catch (err) {
    log('info', err.message.substring(0, 60))
    log('info', `found no ${type} bills on this account`)
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
          fileurl: `https://total.direct-energie.com${fileurl}`,
          filename: `echeancier_${
            type === 'electricite' ? 'elec' : type
          }_${moment(echDate).format('YYYYMMDD')}_directenergie.pdf`,
          vendor: 'Direct Energie',
          metadata: {
            importDate: new Date(),
            version: 3
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
        fileurl: `https://total.direct-energie.com${fileurl}`,
        filename: `${utils.formatDate(date)}_directenergie_${amount.toFixed(
          2
        )}EUR${vendorRef}.pdf`,
        vendor: 'Direct Energie',
        metadata: {
          importDate: new Date(),
          version: 3
        }
      })
    }
  }

  log('info', `found ${bills.length} bills`)

  return bills
}

const start = async fields => {
  const { login, password } = await checkFields(fields)
  const $ = await doLogin(login, password)
  await checkLoginOk($)
  await selectActiveAccount()

  for (const type of ['electricite', 'gaz']) {
    const bills = await parseBills(type)

    if (bills && bills.length)
      await saveBills(bills, fields, {
        requestInstance: request,
        identifiers: ['direct energie']
      })
  }
}

module.exports = new BaseKonnector(start)
