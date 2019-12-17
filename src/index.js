process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://60c5bb56449a4d9bb5bff05b2449d0af@sentry.cozycloud.cc/122'

const {
  log,
  BaseKonnector,
  requestFactory,
  saveBills,
  errors,
  signin,
  scrape,
  utils
} = require('cozy-konnector-libs')
const moment = require('moment')
const request = requestFactory({
  debug: 'json',
  cheerio: true,
  json: false,
  jar: true
})

async function start(fields) {
  const { login, password } = await checkFields(fields)
  await signin({
    requestInstance: request,
    url: 'https://total.direct-energie.com/clients/connexion',
    formSelector: '#fz-form',
    formData: {
      'tx_demmauth_authentification[form][login]': login,
      'tx_demmauth_authentification[form][password]': password
    },
    validate: (statusCode, $, fullResponse) => {
      const alert = $('.cadre--alerte')
      if (alert.length > 0) {
        if (
          alert
            .text()
            .includes('Les informations renseignées ne correspondent pas')
        ) {
          return false
        } else {
          log('error', `Unknown error message : ${alert.text()}`)
          throw new Error(errors.VENDOR_DOWN)
        }
      } else if (fullResponse.request.uri.href.includes('maintenance')) {
        log('error', `Got maintenance url: ${fullResponse.request.uri.href}`)
        throw new Error(errors.VENDOR_DOWN)
      }
      return true
    }
  })
  await selectActiveAccount()

  for (const type of ['electricite', 'gaz']) {
    const bills = await parseBills(type)

    if (bills && bills.length)
      await saveBills(bills, fields, {
        requestInstance: request,
        sourceAccount: this.accountId,
        sourceAccountIdentifier: fields.login,
        linkBankOperations: false,
        fileIdAttributes: ['vendorRef']
      })
  }
}

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

const selectActiveAccount = async () => {
  log('info', 'Selecting active account')
  const $ = await request(
    'https://total.direct-energie.com/clients/mon-compte/gerer-mes-comptes'
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
          if (link) link = 'https://total.direct-energie.com' + link
          return link
        }
      }
    },
    '.contenu-principal__conteneur .cadre.var--no-bottom'
  )

  const activeAccounts = accounts.filter(account => account.isActive)
  if (activeAccounts.length === 0 && accounts.length > 0) {
    log(
      'error',
      `Found no active account but there are ${accounts.length} accounts in total`
    )
    throw new Error('USER_ACTION_NEEDED.ACCOUNT_REMOVED')
  }

  const href = activeAccounts[0].link

  log('info', "Going to the active account's page if needed.")
  if (href) await request(href)
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
          vendor: 'Direct Energie'
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
        fileIdAttributes: ['vendorRef'],
        vendor: 'Direct Energie'
      })
    }
  }

  log('info', `found ${bills.length} bills`)

  return bills
}

module.exports = new BaseKonnector(start)
