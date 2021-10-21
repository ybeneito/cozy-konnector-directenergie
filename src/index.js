process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://60c5bb56449a4d9bb5bff05b2449d0af@sentry.cozycloud.cc/122'

  const {
    BaseKonnector,
    requestFactory,
    scrape,
    log,
    utils,
    signin
  } = require('cozy-konnector-libs')

  const moment = require('moment')
  const cheerio = require('cheerio')

  const request = requestFactory({
    // The debug mode shows all the details about HTTP requests and responses. Very useful for
    // debugging but very verbose. This is why it is commented out by default
    // debug: true,
    // Activates [cheerio](https://cheerio.js.org/) parsing on each page
    cheerio: true,
    // If cheerio is activated do not forget to deactivate json parsing (which is activated by
    // default in cozy-konnector-libs
    json: false,
    // This allows request-promise to keep cookies between requests
    jar: true
  })

  const VENDOR = 'template'
  const baseUrl = 'https://www.totalenergies.fr'

  const courl = baseUrl + '/clients/connexion'

  module.exports = new BaseKonnector(start)

  // The start function is run by the BaseKonnector instance only when it got all the account
  // information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
  // the account information come from ./konnector-dev-config.json file
  // cozyParameters are static parameters, independents from the account. Most often, it can be a
  // secret api key.
  async function start(fields, cozyParameters) {
    log('info', 'Identification')
    if (cozyParameters) log('debug', 'Paramètres trouvés')
    await authenticate.bind(this)(fields.login, fields.password)
    log('info', 'Vous êtes connecté')
    const bills = await parseBill()

    await this.saveBills(bills, fields, {
      fileIdAttributes: ['vendor', 'contractId', 'date', 'amount'],
      linkBankOperations: false,
      identifiers: ['Total energie'],
      sourceAccount: this.accountId,
      sourceAccountIdentifier: fields.login
    })
    log('info', 'Fin de la récupératiob')
  }

  async function authenticate(username, password) {
    log('debug', 'Authentification en cours')
    const $ = await signin({
      url: courl,
      formSelector: '#fz-authentificationForm',
      formData: {
        'tx_demmauth_authentification[authentificationForm][login]': username,
        'tx_demmauth_authentification[authentificationForm][password]': password
      },
      resolveWithFullResponse: true
    })
      .catch(err => {
        log('err', err)
      })
      .then(resp => {
        return resp
      })
  }

  async function parseBill() {
    log('debug', 'Vérification des factures')
    let $
    try {
      $ = await request(
        `https://www.totalenergies.fr/clients/mes-factures/mes-factures-electricite/mon-historique-de-factures`
      )
    } catch (err) {
      log('debug', err.message.substring(0, 60))
      log('debug', `Pas de facture trouvée pour ce compte`)
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
            fileurl: `https://www.totalenergies.fr${fileurl}`,
            filename: `echeancier_${moment(echDate).format(
              'YYYYMMDD'
            )}_TotalEnergies.pdf`,
            vendor: 'Total Energie',
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
          filename: `${utils.formatDate(date)}_TotalEnergies_${amount.toFixed(
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
    return bills
  }

  const normalizeAmount = amount => {
    if (amount.includes('/')) return false
    return parseFloat(
      amount
        .replace('€', '')
        .replace(',', '.')
        .replace(' ', '')
        .trim()
    )
  }
