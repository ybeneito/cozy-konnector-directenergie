const { log, BaseKonnector, requestFactory, saveFiles, addData } = require('cozy-konnector-libs')
const request = requestFactory({
  debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const checkFields = fields => {
  log('Checking the presence of the login and password')
  if (fields.login === undefined) {
    throw new Error('Login is missing');
  }
  if (fields.password === undefined) {
    throw new Error('Password is missing');
  }
  return Promise.resolve({
    login: fields.login,
    password: fields.password
  });
};

const doLogin = (login, password) => {
  return request({
    method: 'POST',
    jar: true,
    url: 'https://clients.direct-energie.com/connexion-clients-particuliers/',
    form: {
      'tx_deauthentification[login]': login,
      'tx_deauthentification[password]': password,
      'tx_deauthentification[form_valid]': '1',
      'tx_deauthentification[redirect_url]': '',
      'tx_deauthentification[mdp_oublie]': 'Je+me+connecte'
    }
  });
};

const checkLoginOk = $ => {
  if($('.formlabel-left.error').length > 0) {
    throw new Error('Login failed');
  }
  return Promise.resolve($);
};

const selectActiveAccount = () => {
  return request({
    method: 'GET',
    jar: true,
    url: 'https://clients.direct-energie.com/mon-compte/gerer-mes-comptes'
  }).then($ => {
    const activeAccounts = $('.compte-actif');

    if(activeAccounts.length === 0) {
      throw new Error('No active accounts for this login.');
    }

    const anchors = $(activeAccounts[0]).parent().find('a')

    let href = null;
    for (let i = 0; i < anchors.length; i++) {
      href = $(anchors[i]).attr('href')
      if (href !== '#') {
        break
      }
    }

    if (href === null) {
      throw new Error("Couldn't find link to the active account.")
    }

    if (href[0] !== '/') {
      href = `/${href}`
    }

    log("Going to the active account's page.")

    return request({
      method: 'GET',
      jar: true,
      url: `https://clients.direct-energie.com${href}`
    })
  });
};

const parseBills = () => {
  return request( {
    method: 'GET',
    jar: true,
    url: 'https://clients.direct-energie.com/mes-factures/ma-facture-mon-echeancier/'
  }).then($ => {
    const bills = [];

    $('table.account-summary').each(function forEachTable () {
      const td = $(this)

      let title = td.find('td.status').text()
      let date = td.find('td.date').text()
      let amount = td.find('td.tarif').text()
      let paidDate = td.find('td.info').text()
      let downloadLink = td.find('td.download a').attr('href')

      // Sanitize.
      title = title.trim()

      date = moment(date, 'DD/MM/YYYY')

      paidDate = paidDate.replace('Payée le', '')
        .replace('En cours', '')
        .replace('Terminé', '')
        .trim()
      paidDate = paidDate.length ? paidDate : date
      paidDate = moment(paidDate, 'DD/MM/YYYY')

      amount = amount.replace(',', '.')
        .replace('€', '')
        .replace('par mois', '')
        .replace('Montant en votre faveur :', '')
        .trim()
      amount = parseFloat(amount)

      downloadLink = `https://clients.direct-energie.com/${downloadLink}`

      const newBill = {
        date,
        paidDate: paidDate || date,
        amount,
        vendor: 'DirectEnergie',
        type: 'energy',
        pdfurl: downloadLink,
        content: title
      }

      bills.push(newBill);

      if (!bills.fetched.length) {
        log('No bills fetched')
        throw new Error('No bills fetched today.')
        return
      }

      log(`Found ${bills.fetched.length} bills.`)

      return saveBills(bills, fields.folderPath, {
        timeout: Date.now() + 60 * 1000,
        identifiers,
        dateDelta: 10,
        amountDelta: 0.1
      })
    })
  })
};

const start = fields => {
  return checkFields(fields)
    .then(({login, password}) => doLogin(login, password))
    .then($ => checkLoginOk($))
    .then($ => selectActiveAccount())
    .then($ => parseBills())
};

module.exports = new BaseKonnector(start);
