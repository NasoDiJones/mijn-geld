// Mijn Geld v35/v37: bankbestand importeren (CSV van NL/BE-banken, CAMT.053 XML, MT940 en sinds v37 ook PDF).
// Alles gebeurt lokaal in de browser: het bestand wordt alleen gelezen, nooit geüpload of bewaard.
// Alleen de transacties die je aanvinkt en met 'Importeren' bevestigt, komen in de app (net als handmatig toegevoegde).
(function (root) {
  'use strict';

  // ==================== HULPFUNCTIES ====================
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u00a0\s]+/g, ' ').trim();
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function validYmd(y, m, d) {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return null;
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }
  function cleanSpaces(s) { return String(s == null ? '' : s).replace(/[\u00a0\s]+/g, ' ').trim(); }
  function looksLikeIban(s) { return /^[A-Z]{2}\d{2}[A-Z0-9 ]{8,32}$/i.test(String(s || '').trim()) && /\d{6,}/.test(String(s).replace(/\s/g, '')); }
  function normIban(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }

  // ==================== TEKST DECODEREN ====================
  // UTF-8 als dat geldig is, anders Windows-1252 (veel bankexports, bijv. Belgische banken, zijn geen UTF-8).
  function decodeBytes(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const TD = (typeof TextDecoder !== 'undefined') ? TextDecoder : null;
    let text = null;
    if (TD) {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) { try { text = new TD('utf-16le').decode(bytes); } catch (e) {} }
      else if (bytes[0] === 0xFE && bytes[1] === 0xFF) { try { text = new TD('utf-16be').decode(bytes); } catch (e) {} }
      if (text == null) { try { text = new TD('utf-8', { fatal: true }).decode(bytes); } catch (e) { text = null; } }
      if (text == null) { try { text = new TD('windows-1252').decode(bytes); } catch (e) { text = null; } }
    }
    if (text == null) { text = ''; for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]); }
    return text.replace(/^\uFEFF/, '');
  }

  // ==================== DATUM & BEDRAG ====================
  // order: 'dmy' (standaard, Europees) of 'mdy' (alleen als de kolom dat duidelijk maakt).
  function parseDate(raw, order) {
    const s = cleanSpaces(raw).replace(/^"|"$/g, '');
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return validYmd(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T\s].*)?$/))) return validYmd(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})(?:[T\s,].*)?$/))) {
      let y = +m[3]; if (m[3].length === 2) y += 2000;
      const a = +m[1], b = +m[2];
      return order === 'mdy' ? validYmd(y, a, b) : validYmd(y, b, a);
    }
    if ((m = s.match(/^(\d{2})(\d{2})(\d{2})$/))) return validYmd(2000 + +m[1], +m[2], +m[3]); // jjmmdd
    const months = { jan: 1, feb: 2, mrt: 3, mar: 3, maa: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12,
      janv: 1, fevr: 2, mars: 3, avr: 4, mai: 5, juin: 6, juil: 7, aout: 8, sept: 9 };
    if ((m = norm(s).match(/^(\d{1,2})[\s.-]+([a-z]{3,5})\.?[\s.-]+(\d{4})/))) {
      const mon = months[m[2]] || months[m[2].slice(0, 3)];
      if (mon) return validYmd(+m[3], mon, +m[1]);
    }
    return null;
  }
  function detectDateOrder(values) {
    let firstBig = 0, secondBig = 0;
    values.forEach(v => {
      const m = cleanSpaces(v).match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.]\d{2,4}/);
      if (!m) return;
      if (+m[1] > 12) firstBig++;
      if (+m[2] > 12) secondBig++;
    });
    return secondBig > 0 && firstBig === 0 ? 'mdy' : 'dmy';
  }
  // Welk decimaalteken gebruikt deze kolom? Kijkt naar waarden die eindigen op [.,] + 1–2 cijfers.
  function detectDecimal(values) {
    let comma = 0, dot = 0;
    values.forEach(v => {
      const s = String(v || '').replace(/[^\d.,]/g, '');
      if (/,\d{1,2}$/.test(s)) comma++;
      else if (/\.\d{1,2}$/.test(s)) dot++;
      if (/\.\d{3},/.test(s)) comma += 2;
      if (/,\d{3}\./.test(s)) dot += 2;
    });
    return dot > comma ? '.' : ',';
  }
  // Geeft een getal (met teken) of null. '1.234,56', '-12,50', '+12,50', '12.50', '€ 1 234,56', '(12,50)', '12,50-'.
  function parseAmount(raw, decimal) {
    let s = cleanSpaces(raw).replace(/^"|"$/g, '');
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/(EUR|€|eur)/g, '').trim();
    if (/^[-\u2212]/.test(s)) { neg = true; s = s.slice(1); }
    else if (/^\+/.test(s)) s = s.slice(1);
    if (/[-\u2212]$/.test(s)) { neg = true; s = s.slice(0, -1); }
    s = s.replace(/[\s']/g, '');
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
    let num;
    if (lastComma >= 0 && lastDot >= 0) {
      const dec = lastComma > lastDot ? ',' : '.';
      const thou = dec === ',' ? '.' : ',';
      num = parseFloat(s.split(thou).join('').replace(dec, '.'));
    } else if (lastComma >= 0 || lastDot >= 0) {
      const sep = lastComma >= 0 ? ',' : '.';
      const parts = s.split(sep);
      const after = parts[parts.length - 1];
      let isDecimal;
      if (parts.length > 2) isDecimal = false;
      else if (after.length !== 3) isDecimal = true;
      else isDecimal = (decimal || ',') === sep;
      num = isDecimal ? parseFloat(parts.slice(0, -1).join('') + '.' + after) : parseFloat(parts.join(''));
    } else num = parseFloat(s);
    if (!isFinite(num)) return null;
    num = Math.round(num * 100) / 100;
    return neg ? -num : num;
  }

  // ==================== CSV ====================
  function detectDelimiter(text) {
    const sample = text.split(/\r\n|\n|\r/).filter(l => l.trim()).slice(0, 30);
    const cands = [';', ',', '\t', '|'];
    let best = ',', bestScore = -1;
    cands.forEach(d => {
      const counts = sample.map(l => splitLine(l, d).length);
      const multi = counts.filter(c => c > 1);
      if (!multi.length) return;
      // Meest voorkomende kolomtelling en hoe vaak die voorkomt (consistentie), gewogen naar kolommen.
      const freq = {}; multi.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
      const [mode, n] = Object.entries(freq).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      const score = n * 10 + Math.min(+mode, 30);
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }
  function splitLine(line, d) { return parseCsv(line, d)[0] || []; }
  // RFC 4180-achtig: aanhalingstekens, "" binnen een veld, regeleinden binnen een veld.
  function parseCsv(text, d) {
    const rows = []; let row = [], field = '', inQ = false, i = 0, quotedField = false;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && (field.trim() === '')) { inQ = true; quotedField = true; field = ''; i++; continue; }
      if (c === d) { row.push(quotedField ? field : field.trim()); field = ''; quotedField = false; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(quotedField ? field : field.trim()); rows.push(row); row = []; field = ''; quotedField = false;
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(quotedField ? field : field.trim()); rows.push(row); }
    return rows.filter(r => r.some(x => String(x).trim() !== ''));
  }

  // Kolomrollen op kopnaam (genormaliseerd, zonder accenten). Volgorde = voorkeur.
  const ROLE_HEADERS = {
    date: ['datum', 'boekingsdatum', 'boekdatum', 'transactiedatum', 'uitvoeringsdatum', 'datum verrichting', 'verrichtingsdatum', 'date', 'booking date', 'transaction date',
      'date de comptabilisation', 'date comptable', "date d'execution", 'date operation', "date de l'operation", 'transactiondate', 'started date', 'completed date', 'datum boeking'],
    valueDate: ['valutadatum', 'valuedatum', 'rentedatum', 'value date', 'date valeur', 'interest date', 'valuta datum'],
    amount: ['bedrag (eur)', 'bedrag', 'amount (eur)', 'amount', 'montant', 'bedrag eur', 'transactiebedrag', 'montant (eur)', 'bedrag in eur'],
    debit: ['af', 'debet', 'debit', 'uitgaven', 'bedrag af', 'debet bedrag', 'afschrijving', 'montant debit'],
    credit: ['bij', 'credit', 'ontvangsten', 'bedrag bij', 'credit bedrag', 'bijschrijving', 'montant credit'],
    sign: ['af bij', 'af/bij', 'debit/credit', 'debet/credit', 'credit/debet', 'd/c', 'c/d', 'debit credit', 'debet credit', 'bij/af', 'type (af/bij)', 'credit debet indicator'],
    name: ['naam / omschrijving', 'naam/omschrijving', 'name / description', 'naam tegenpartij', 'naam tegenrekening', 'naam van de tegenpartij', 'naam tegenpartij bevat', 'tegenpartij naam',
      'counterparty name', 'nom de la contrepartie', 'nom contrepartie', 'nom du beneficiaire', 'naam', 'name', 'begunstigde', 'opdrachtgever', 'payee'],
    iban: ['tegenrekening', 'tegenrekening iban/bban', 'rekening tegenpartij', 'tegenrekening iban', 'iban tegenpartij', 'counterparty account', 'counter account', 'counterparty',
      'compte partie adverse', 'compte contrepartie', 'compte de la contrepartie', 'rekeningnummer tegenpartij', 'tegenpartij', 'iban/bban tegenpartij', 'contrepartie'],
    desc: ['omschrijving', 'mededelingen', 'mededeling', 'detail van de omzet', 'details van de omzet', 'details', 'bericht', 'description', 'notifications', 'entry details', 'message',
      'libelles', 'libelle', 'details du mouvement', 'communication', 'communicatie', 'vrije mededeling', 'gestructureerde mededeling', 'omschrijving-1', 'omschrijving-2', 'omschrijving-3',
      'transactie', 'beschrijving', 'type verrichting', 'mutatiesoort', 'transaction type', 'type', 'reference', 'notes'],
    entryId: ['omzetnummer', 'volgnr', 'volgnummer', 'entry number', 'numero de mouvement', 'verrichtingsnummer', 'verrichtingnummer', 'transactienummer', 'transactiereferentie', 'numero d\'operation'],
    currency: ['munteenheid', 'munt', 'currency', 'devise', 'devies', 'valuta rekening', 'valuta'],
    account: ['rekening', 'rekeningnummer', 'iban/bban', 'account', 'account number', 'numero de compte', 'iban', 'eigen rekening', 'rekening iban'],
    accountName: ['naam van de rekening', 'rekening naam', 'rekeningnaam', 'account name', 'nom du compte'],
    balance: ['saldo na mutatie', 'saldo na trn', 'saldo', 'balance', 'resulting balance', 'solde']
  };
  const DESC_LOW = ['mutatiesoort', 'transaction type', 'type verrichting', 'type', 'transactie'];

  function headerScore(cells) {
    const hs = cells.map(c => norm(c).replace(/[:*]/g, ''));
    let s = 0;
    const has = role => hs.some(h => ROLE_HEADERS[role].includes(h));
    if (has('date')) s += 3;
    if (has('amount') || (has('debit') && has('credit'))) s += 3;
    ['name', 'iban', 'desc', 'sign', 'valueDate', 'currency', 'entryId', 'account'].forEach(r => { if (has(r)) s += 1; });
    return s;
  }

  // Bepaal per kolom de rol, met de inhoud als tweede bron (bijv. KBC 'Valuta' = valutadatum, ING 'Valuta' = munt).
  function mapColumns(headers, rows) {
    const hs = headers.map(h => norm(h).replace(/[:*]/g, ''));
    const col = idx => rows.slice(0, 50).map(r => r[idx]).filter(v => v != null && String(v).trim() !== '');
    const isDateCol = idx => { const v = col(idx); return v.length > 0 && v.filter(x => parseDate(x, 'dmy') || parseDate(x, 'mdy')).length >= v.length * 0.8; };
    const isIbanCol = idx => { const v = col(idx); return v.length > 0 && v.filter(looksLikeIban).length >= v.length * 0.6; };
    const isAmountCol = idx => { const v = col(idx); return v.length > 0 && v.filter(x => parseAmount(x) !== null).length >= v.length * 0.8; };
    const map = { desc: [] };
    const used = new Set();
    const take = (role, test) => {
      for (const name of ROLE_HEADERS[role]) {
        for (let i = 0; i < hs.length; i++) {
          if (used.has(i) || hs[i] !== name) continue;
          if (test && !test(i)) continue;
          used.add(i); return i;
        }
      }
      return -1;
    };
    // 'Valuta' kan een datum (KBC) of een munt (ING vreemde valuta) zijn.
    map.date = take('date', i => isDateCol(i) || col(i).length === 0);
    map.valueDate = take('valueDate', i => isDateCol(i) || col(i).length === 0);
    if (map.date < 0 && map.valueDate >= 0) { map.date = map.valueDate; map.valueDate = -1; }
    map.sign = take('sign');
    map.amount = take('amount', i => isAmountCol(i) || col(i).length === 0);
    map.debit = take('debit', i => isAmountCol(i) || col(i).length === 0);
    map.credit = take('credit', i => isAmountCol(i) || col(i).length === 0);
    // Sommige banken (bijv. KBC) hebben zowel 'Bedrag' als credit/debet: dan is Bedrag (met teken) leidend.
    map.entryId = take('entryId');
    map.accountName = take('accountName');
    map.account = take('account', i => isIbanCol(i) || col(i).length === 0);
    map.iban = take('iban', i => isIbanCol(i) || col(i).length === 0);
    map.name = take('name', i => !isIbanCol(i) || col(i).length === 0);
    map.currency = take('currency', i => !isDateCol(i));
    map.balance = take('balance');
    // Overige omschrijvingskolommen, in de volgorde van het bestand (met 'mutatiesoort' e.d. als laatste redmiddel).
    const descIdx = [], lowIdx = [];
    hs.forEach((h, i) => {
      if (used.has(i)) return;
      if (ROLE_HEADERS.desc.includes(h)) (DESC_LOW.includes(h) ? lowIdx : descIdx).push(i);
    });
    // Rabobank: 'Naam uiteindelijke partij' / 'Naam initiërende partij' zijn reserve-namen.
    map.altName = hs.map((h, i) => (!used.has(i) && /^naam (uiteindelijke|initierende) partij$/.test(h)) ? i : -1).filter(i => i >= 0);
    map.desc = descIdx; map.descLow = lowIdx;
    return map;
  }
  function mappingComplete(map) { return map && map.date >= 0 && (map.amount >= 0 || (map.debit >= 0 && map.credit >= 0) || map.debit >= 0 || map.credit >= 0); }

  function signFromIndicator(v) {
    const s = norm(v);
    if (!s) return 0;
    if (/^(af|d|db|dbit|debet|debit|-|uit|afschrijving|out)$/.test(s)) return -1;
    if (/^(bij|c|cr|crdt|credit|\+|in|bijschrijving)$/.test(s)) return 1;
    return 0;
  }

  // Zet ruwe CSV-regels om naar transacties met een kolomindeling.
  function rowsToTransactions(rows, map) {
    const dateOrder = detectDateOrder(rows.map(r => r[map.date]));
    const amountCols = [map.amount, map.debit, map.credit].filter(i => i >= 0);
    const decimal = detectDecimal([].concat(...amountCols.map(i => rows.map(r => r[i]))));
    const out = [], errors = [];
    rows.forEach((r, n) => {
      const get = i => (i >= 0 && r[i] != null) ? cleanSpaces(r[i]) : '';
      const date = parseDate(get(map.date), dateOrder) || (map.valueDate >= 0 ? parseDate(get(map.valueDate), dateOrder) : null);
      let amount = null;
      if (map.amount >= 0 && get(map.amount) !== '') amount = parseAmount(get(map.amount), decimal);
      if (amount === null && (map.debit >= 0 || map.credit >= 0)) {
        const d = map.debit >= 0 ? parseAmount(get(map.debit), decimal) : null;
        const c = map.credit >= 0 ? parseAmount(get(map.credit), decimal) : null;
        if (d) amount = -Math.abs(d); else if (c) amount = Math.abs(c); else if (d === 0 || c === 0) amount = 0;
      }
      if (!date || amount === null) { if (r.some(x => String(x).trim())) errors.push(n); return; }
      if (map.sign >= 0) { const s = signFromIndicator(get(map.sign)); if (s) amount = s * Math.abs(amount); }
      if (amount === 0) return;
      const descParts = map.desc.map(get).filter(Boolean);
      const lowParts = (map.descLow || []).map(get).filter(Boolean);
      let name = get(map.name);
      if (!name && map.altName) name = map.altName.map(get).find(Boolean) || '';
      out.push({
        date, amount,
        name,
        iban: normIban(get(map.iban)),
        account: normIban(get(map.account)),
        accountName: get(map.accountName),
        entryId: get(map.entryId),
        currency: get(map.currency).toUpperCase(),
        text: descParts.join(' '),
        textLow: lowParts.join(' ')
      });
    });
    return { txs: out, errors };
  }

  // ABN AMRO TXT (tab, zonder kopregel): rekening, munt, transactiedatum, startsaldo, eindsaldo, rentedatum, bedrag, omschrijving.
  function detectHeaderless(rows) {
    const sample = rows.slice(0, 20);
    if (sample.length && sample.every(r => r.length >= 8 && /^\d{8}$/.test(String(r[2]).trim()) && parseAmount(r[6]) !== null && /^[A-Z]{3}$/.test(String(r[1]).trim()))) {
      return { bank: 'ABN AMRO (TXT)', map: { date: 2, valueDate: 5, amount: 6, debit: -1, credit: -1, sign: -1, name: -1, iban: -1, account: 0, accountName: -1, entryId: -1, currency: 1, balance: 4, desc: [7], descLow: [], altName: [] } };
    }
    return null;
  }

  function guessBank(headers, text) {
    const h = headers.map(norm).join('|');
    if (h.includes('naam / omschrijving') || h.includes('name / description')) return 'ING Nederland';
    if (h.includes('omzetnummer') || h.includes('detail van de omzet') || h.includes('numero de mouvement') || h.includes('entry details')) return 'ING België';
    if (h.includes('volgnr') && h.includes('omschrijving-1')) return 'Rabobank';
    if (h.includes('afschriftnummer') && h.includes('naam tegenpartij')) return 'KBC';
    if (h.includes('rekeninguittrekselnummer') || h.includes('naam tegenpartij bevat')) return 'Belfius';
    if (h.includes('naam van de tegenpartij') && h.includes('type verrichting')) return 'BNP Paribas Fortis';
    if (h.includes('boekdatum') && h.includes('verrichtingsdatum')) return 'Argenta';
    if (h.includes('interest date') && h.includes('counterparty')) return 'bunq';
    if (h.includes('rekening naam') && h.includes('af bij')) return 'ING Nederland (spaarrekening)';
    return null;
  }

  function parseCsvText(text, forcedMap) {
    const delim = detectDelimiter(text);
    const all = parseCsv(text, delim);
    if (!all.length) return { error: 'Het bestand is leeg.' };
    // Zoek de kopregel in de eerste 25 regels (sommige banken zetten er eerst rekeninginfo boven).
    let hIdx = -1, best = 0;
    for (let i = 0; i < Math.min(25, all.length); i++) {
      const sc = headerScore(all[i]);
      if (sc > best) { best = sc; hIdx = i; }
    }
    let headers = null, body = all, map = null, bank = null;
    if (forcedMap) {
      headers = forcedMap.hasHeader ? all[forcedMap.headerRow || 0] : null;
      body = forcedMap.hasHeader ? all.slice((forcedMap.headerRow || 0) + 1) : all;
      map = forcedMap;
    } else if (hIdx >= 0 && best >= 6) {
      headers = all[hIdx];
      body = all.slice(hIdx + 1);
      // ING NL: bij 'alle rekeningen' kan er een tweede kopregel middenin staan; die slaan we over.
      body = body.filter(r => headerScore(r) < 6);
      map = mapColumns(headers, body);
      bank = guessBank(headers, text);
    } else {
      const hl = detectHeaderless(all);
      if (hl) { map = hl.map; bank = hl.bank; body = all; }
    }
    if (!map || !mappingComplete(map)) {
      return { needsMapping: true, delimiter: delim, rows: all, headerRow: hIdx >= 0 && best >= 3 ? hIdx : -1, partialMap: map, headers };
    }
    const res = rowsToTransactions(body, map);
    return { format: 'CSV', bank, delimiter: delim, txs: res.txs, errors: res.errors.length, map, headers };
  }

  // ==================== CAMT.053 ====================
  function parseCamt(text) {
    const DP = (typeof DOMParser !== 'undefined') ? DOMParser : null;
    if (!DP) return { error: 'XML lezen wordt niet ondersteund.' };
    const doc = new DP().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return { error: 'Dit XML-bestand is beschadigd.' };
    const kids = (el, name) => el ? Array.from(el.children || []).filter(c => c.localName === name) : [];
    const kid = (el, name) => kids(el, name)[0] || null;
    const path = (el, ...names) => { let cur = el; for (const n of names) { cur = kid(cur, n); if (!cur) return null; } return cur; };
    const txt = el => el ? cleanSpaces(el.textContent) : '';
    const all = (el, name) => el ? Array.from(el.getElementsByTagNameNS('*', name)) : [];
    const out = [];
    all(doc, 'Stmt').concat(all(doc, 'Rpt')).forEach(stmt => {
      const account = normIban(txt(path(stmt, 'Acct', 'Id', 'IBAN')));
      kids(stmt, 'Ntry').forEach(ntry => {
        const sts = txt(kid(ntry, 'Sts')) ;
        if (sts && /PDNG|INFO/i.test(sts)) return; // alleen geboekte posten
        const amtEl = kid(ntry, 'Amt');
        const amount = parseFloat(txt(amtEl));
        if (!isFinite(amount) || amount === 0) return;
        const dbit = /DBIT/i.test(txt(kid(ntry, 'CdtDbtInd')));
        const rvsl = /true/i.test(txt(kid(ntry, 'RvslInd')));
        const sign = (dbit ? -1 : 1) * (rvsl ? -1 : 1);
        const date = parseDate(txt(path(ntry, 'BookgDt', 'Dt')) || txt(path(ntry, 'BookgDt', 'DtTm')).slice(0, 10))
          || parseDate(txt(path(ntry, 'ValDt', 'Dt')) || txt(path(ntry, 'ValDt', 'DtTm')).slice(0, 10));
        if (!date) return;
        const tx = all(ntry, 'TxDtls')[0] || null;
        const party = dbit ? 'Cdtr' : 'Dbtr';
        let name = '', iban = '';
        if (tx) {
          const rp = all(tx, 'RltdPties')[0];
          if (rp) {
            name = txt(path(rp, party, 'Nm')) || txt(path(rp, party, 'Pty', 'Nm')) || txt(path(rp, 'Ultmt' + party, 'Nm'));
            iban = normIban(txt(path(rp, party + 'Acct', 'Id', 'IBAN')));
          }
        }
        const ustrd = all(tx || ntry, 'Ustrd').map(txt).filter(Boolean).join(' ');
        const strd = all(tx || ntry, 'Ref').filter(r => r.parentNode && r.parentNode.localName === 'CdtrRefInf').map(txt).join(' ');
        const addl = txt(kid(ntry, 'AddtlNtryInf')) || (tx ? txt(kid(tx, 'AddtlTxInf')) : '');
        const ref = txt(kid(ntry, 'AcctSvcrRef')) || txt(kid(ntry, 'NtryRef'));
        out.push({ date, amount: Math.round(sign * amount * 100) / 100, name, iban, account, accountName: '', entryId: ref,
          currency: (amtEl && amtEl.getAttribute('Ccy')) || '', text: [ustrd, strd].filter(Boolean).join(' '), textLow: addl });
      });
    });
    return { format: 'CAMT.053', bank: null, txs: out, errors: 0 };
  }

  // ==================== MT940 ====================
  function parseMt940(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const fields = []; let cur = null;
    lines.forEach(l => {
      const m = l.match(/^:(\d{2}[A-Z]?):(.*)$/);
      if (m) { cur = { tag: m[1], val: m[2] }; fields.push(cur); }
      else if (cur && l.trim() && !/^-\}?$/.test(l.trim()) && !/^\{/.test(l)) cur.val += '\n' + l;
    });
    const out = []; let account = '', last = null;
    fields.forEach(f => {
      if (f.tag === '25') account = normIban(f.val.split('/')[0].replace(/[^A-Z0-9]/gi, ''));
      if (f.tag === '61') {
        const m = f.val.replace(/\n/g, '').match(/^(\d{2})(\d{2})(\d{2})(\d{4})?(R?[DC])([A-Z])?(\d+,\d*)(.*)$/);
        if (!m) { last = null; return; }
        const date = validYmd(2000 + +m[1], +m[2], +m[3]);
        let amount = parseFloat(m[7].replace(',', '.'));
        const ind = m[5];
        const neg = ind === 'D' || ind === 'RC';
        amount = Math.round((neg ? -amount : amount) * 100) / 100;
        const refPart = (m[8] || '').slice(4);
        last = { date, amount, name: '', iban: '', account, accountName: '', entryId: '', currency: '', text: '', textLow: '', ref61: refPart.split('//')[1] || '' };
        if (date && amount) out.push(last);
      }
      if (f.tag === '86' && last) {
        const v = f.val.replace(/\n/g, '');
        const sub = key => { const r = new RegExp('/' + key + '/([^/]*)'); const mm = v.match(r); return mm ? cleanSpaces(mm[1]) : ''; };
        if (/\/(NAME|REMI|IBAN|CNTP|TRTP)\//.test(v)) {
          last.name = sub('NAME');
          const cntp = v.match(/\/CNTP\/([^/]*)\/([^/]*)\/([^/]*)\//);
          if (cntp) { last.iban = normIban(cntp[1]); if (!last.name) last.name = cleanSpaces(cntp[3]); }
          if (!last.iban) last.iban = normIban(sub('IBAN'));
          const remi = v.match(/\/REMI\/(?:USTD\/\/)?(.*?)(?:\/(?:EREF|ORDP|BENM|CSID|MARF|ISDT|ULTD|ULTC|SVCL|PURP|IBAN|BIC)\/|$)/);
          last.text = remi ? cleanSpaces(remi[1].replace(/^STRD\/CUR\/|^STRD\/ISO\/|^STRD\/\/|^USTD\/\//, '').replace(/\/$/, '')) : '';
          last.textLow = sub('TRTP');
        } else {
          last.text = cleanSpaces(f.val);
        }
        last = null;
      }
    });
    return { format: 'MT940', bank: null, txs: out, errors: 0 };
  }

  // ==================== PDF (v37) ====================
  // De PDF wordt in de browser gelezen met pdf.js (vendor/pdfjs, pas geladen als je een PDF kiest).
  // Uit de tekstposities bouwen we regels en kolommen op en daaruit de transacties.
  const PDF_MONTHS = { jan: 1, januari: 1, january: 1, janv: 1, janvier: 1, feb: 2, febr: 2, februari: 2, february: 2, fev: 2, fevr: 2, fevrier: 2,
    mrt: 3, maa: 3, maart: 3, mar: 3, march: 3, mars: 3, apr: 4, april: 4, avr: 4, avril: 4, mei: 5, may: 5, mai: 5,
    jun: 6, juni: 6, june: 6, juin: 6, jul: 7, juli: 7, july: 7, juil: 7, juillet: 7, aug: 8, augustus: 8, august: 8, aout: 8,
    sep: 9, sept: 9, september: 9, septembre: 9, okt: 10, oktober: 10, oct: 10, october: 10, octobre: 10,
    nov: 11, november: 11, novembre: 11, dec: 12, december: 12, decembre: 12 };
  const PDF_WEEKDAY = /^(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|ma|di|wo|do|vr|za|zo|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\.?,?$/i;
  const PDF_DATE_NUM = /^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{4}|\d{2}))?$/;
  const PDF_DATE_TXT = /^(\d{1,2})\.?\s+([a-z]{3,10})\.?(?:\s+(\d{4}))?$/;
  // Bedrag met decimale komma (Europees): -1.350,00 | 1 350,00 | € 12,50 | 12,50 EUR | 12,50- | 471,31 +/CREDIT
  const PDF_AMT = /(^|\s)([-+\u2212]\s?)?(€\s?)?([-+\u2212]\s?)?(\d{1,3}(?:[.\u00a0\u202f ]\d{3})+|\d+),(\d{2})(\s?(?:EUR|€))?(\s?(?:\+\/CREDIT|-\/DEBET|\+\/CR|-\/DB)|\s?[-+](?=\s|$)|\s(?:D|C|DB|CR|Db|Cr|DT|CT)(?=\s|$))?(?=\s|$)/g;

  function pdfYmdFromMeta(s) {
    const m = String(s || '').match(/(\d{4})(\d{2})(\d{2})/);
    return m ? validYmd(+m[1], +m[2], +m[3]) : null;
  }
  // Datum uit één stukje tekst; zonder jaar wordt het jaar uit het document gebruikt (en nooit ver in de toekomst).
  function pdfDate(raw, ctx) {
    let s = norm(raw).replace(/^\(|\)$/g, '');
    s = s.split(' ').filter(w => !PDF_WEEKDAY.test(w)).join(' ');
    let m, y = null, mo, d;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return validYmd(+m[1], +m[2], +m[3]);
    if ((m = s.match(PDF_DATE_NUM))) { d = +m[1]; mo = +m[2]; if (m[3]) y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; }
    else if ((m = s.match(PDF_DATE_TXT)) && PDF_MONTHS[m[2]]) { d = +m[1]; mo = PDF_MONTHS[m[2]]; if (m[3]) y = +m[3]; }
    else if (ctx && ctx.ref && /^(vandaag|aujourd'hui|today)$/.test(s)) return ctx.ref;
    else if (ctx && ctx.ref && /^(gisteren|hier|yesterday)$/.test(s)) { const t = new Date(ctx.ref + 'T12:00:00'); t.setDate(t.getDate() - 1); return validYmd(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
    else return null;
    if (y) return validYmd(y, mo, d);
    if (!ctx || !ctx.ref) return null;
    const ry = +ctx.ref.slice(0, 4);
    let out = validYmd(ry, mo, d);
    if (out && out > ctx.ref) { const t = new Date(ctx.ref + 'T12:00:00'); t.setDate(t.getDate() + 7); if (out > validYmd(t.getFullYear(), t.getMonth() + 1, t.getDate())) out = validYmd(ry - 1, mo, d); }
    return out;
  }
  function pdfAmounts(text) {
    const out = []; let m;
    PDF_AMT.lastIndex = 0;
    while ((m = PDF_AMT.exec(text))) {
      const neg = /[-\u2212]/.test((m[2] || '') + (m[4] || '')) || /^\s?(-|-\/DEBET|-\/DB|D|DB|Db|DT)$/.test(m[8] || '');
      const pos = /\+/.test((m[2] || '') + (m[4] || '')) || /^\s?(\+|\+\/CREDIT|\+\/CR|C|CR|Cr|CT)$/.test(m[8] || '');
      const v = parseFloat(m[5].replace(/[.\u00a0\u202f ]/g, '') + '.' + m[6]);
      out.push({ value: v, signed: neg || pos, neg, start: m.index + m[1].length, end: PDF_AMT.lastIndex, euro: !!(m[3] || m[7]) });
    }
    return out;
  }

  // Tekstfragmenten → regels (zelfde hoogte) → cellen (grote horizontale tussenruimte = andere kolom).
  function pdfLines(doc) {
    const out = [];
    (doc.pages || []).forEach((pg, pi) => {
      const items = (pg.items || []).filter(it => it && it.str && it.str.trim()).map(it => ({ str: it.str, x: +it.x || 0, y: +it.y || 0, w: Math.max(0, +it.w || 0), h: Math.max(4, Math.abs(+it.h || 10)) }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      items.forEach(it => {
        let line = null;
        for (let k = lines.length - 1; k >= 0 && k >= lines.length - 4; k--) {
          if (Math.abs(lines[k].y - it.y) <= Math.max(2, Math.min(lines[k].h, it.h) * 0.45)) { line = lines[k]; break; }
        }
        if (!line) { line = { y: it.y, h: it.h, items: [] }; lines.push(line); }
        line.items.push(it);
      });
      lines.forEach(l => {
        l.items.sort((a, b) => a.x - b.x);
        const cells = [];
        l.items.forEach(it => {
          const c = cells[cells.length - 1];
          const gap = c ? it.x - c.x1 : Infinity;
          if (c && gap < Math.max(4, it.h * 0.9)) {
            const sp = gap > it.h * 0.12 && !/\s$/.test(c.text) && !/^\s/.test(it.str);
            c.text += (sp ? ' ' : '') + it.str; c.x1 = Math.max(c.x1, it.x + it.w);
          } else cells.push({ text: it.str, x0: it.x, x1: it.x + it.w });
        });
        cells.forEach(c => { c.text = cleanSpaces(c.text); });
        const cs = cells.filter(c => c.text);
        if (cs.length) out.push({ page: pi, y: l.y, h: l.h, cells: cs, text: cs.map(c => c.text).join('  '), width: +pg.width || 600 });
      });
    });
    return out;
  }
  function pdfBank(all) {
    const t = all.toLowerCase();
    if (/ing belgi[eë]|ing belgium|bbrubebb|home'bank|marnixlaan 24/.test(t)) return 'ING België';
    if (/ing bank n\.?v\.?|ingbnl2a|mijn ing/.test(t)) return 'ING Nederland';
    if (/kredbebb|kbc bank/.test(t)) return 'KBC';
    if (/gkccbebb|belfius/.test(t)) return 'Belfius';
    if (/gebabebb|bnp paribas fortis/.test(t)) return 'BNP Paribas Fortis';
    if (/arspbe22|argenta/.test(t)) return 'Argenta';
    if (/abnanl2a|abn amro/.test(t)) return 'ABN AMRO';
    if (/rabonl2u|rabobank/.test(t)) return 'Rabobank';
    if (/bunqnl2a|bunq/.test(t)) return 'bunq';
    return null;
  }
  const IBAN_IN = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?)\b/;

  // --- ING België: 'Details transactie' (PDF uit de ING-app, één verrichting per pagina) ---
  function parseIngDetailPdf(lines) {
    const txs = []; let errors = 0;
    const START = /^(details transactie|details van de transactie|detail(s)? de la transaction|details de l'operation|transaction details)$/;
    const KEY = /^(naar|van|ten gunste van|ten laste van|opdrachtgever|begunstigde|vers|de|en faveur de|a charge de|beneficiaire|donneur d'ordre|to|from|in favour of|mededeling|communication|message|persoonlijke info|info personnelle|personal info|valutadatum|date valeur|value date|verrichtingnummer|verrichtingsnummer|numero d'operation|numero de l'operation|transaction number|iban|bic|referentie|reference|kaartnummer|numero de carte|card number|datum|date|uur|heure|time|plaats|lieu|place)\s*:\s*(.*)$/;
    const NAMEKEY = /^(naar|van|ten gunste van|ten laste van|opdrachtgever|begunstigde|vers|de|en faveur de|a charge de|beneficiaire|donneur d'ordre|to|from|in favour of)$/;
    const FOOT = /^(dit document werd gegenereerd|ce document a ete genere|this document was generated)|ing belgi[eë] \/ nv|ing belgique|ing belgium sa/;
    let account = '';
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const n = norm(l.text);
      if (IBAN_IN.test(l.text) && !START.test(n) && !txs.length && /^[A-Z]{2}\d{2}/.test(l.cells[0].text)) account = normIban(l.text.match(IBAN_IN)[1]);
      if (!START.test(n)) continue;
      // Rekening: de IBAN boven 'Details transactie' op dezelfde pagina.
      for (let k = i - 1; k >= 0 && lines[k].page === l.page; k--) {
        if (/^[A-Z]{2}\d{2}/.test(lines[k].cells[0].text) && IBAN_IN.test(lines[k].text)) { account = normIban(lines[k].text.match(IBAN_IN)[1]); break; }
      }
      const block = [];
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k].page !== l.page || START.test(norm(lines[k].text)) || FOOT.test(norm(lines[k].text))) break;
        block.push(lines[k]);
      }
      // Bedrag: eerste regel met een bedrag; datum: linkerkolom (bijv. 'maandag' / '2 mrt 2026').
      let amount = null, date = null, currency = '', descX = null, ai = -1;
      for (let k = 0; k < block.length && k < 6; k++) {
        const am = pdfAmounts(block[k].text);
        if (am.length && amount === null) {
          const a = am[am.length - 1]; amount = a.neg ? -a.value : a.value; ai = k;
          const cm = block[k].text.match(/\b(EUR|USD|GBP|CHF)\b/); currency = cm ? cm[1] : 'EUR';
          const descCell = block[k].cells.find(c => /^(beschrijving|description|omschrijving)$/i.test(c.text));
          if (descCell) descX = descCell.x0;
        }
        if (!date) for (const c of block[k].cells) { const d = pdfDate(c.text, null); if (d) { date = d; break; } }
      }
      if (descX === null) descX = Math.min(...block.map(b => (b.cells[1] || b.cells[0]).x0).filter(isFinite).concat([150]));
      // Tekst in de rechterkolom (alles behalve datum/weekdag/bedrag), regel per regel.
      const rows = [];
      block.forEach((b, k) => {
        const parts = b.cells.filter(c => c.x0 >= descX - 4).map(c => c.text)
          .filter(t => !/^(beschrijving|description|omschrijving)$/i.test(t) && !(k === ai && pdfAmounts(t).length && pdfAmounts(t)[0].start === 0 && t.length <= 24));
        const txt = cleanSpaces(parts.join(' ').replace(new RegExp('(?:^|\\s)-?[\\d.]+,\\d{2}\\s?(?:EUR|€)$'), ''));
        if (txt) rows.push(txt);
      });
      if (!date || amount === null || !amount) { errors++; continue; }
      const type = rows[0] || '';
      let name = '', iban = '', medParts = [], entryId = '', valueDate = '', other = [], mode = null;
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r]; const nr = norm(row);
        if (nr === norm(type)) { mode = null; continue; } // tweede (uitgebreide) blok begint opnieuw met het type
        const m = nr.match(KEY);
        if (m) {
          const key = m[1]; const val = cleanSpaces(row.slice(row.indexOf(':') + 1));
          mode = null;
          if (NAMEKEY.test(key)) {
            if (!name) {
              let v = val; const ib = v.match(/\s+-\s+([A-Z]{2}\d{2}[A-Z0-9 ]{8,})$/);
              if (ib) { if (!iban) iban = normIban(ib[1]); v = v.slice(0, ib.index); }
              if (v) name = v; else mode = 'name';
            }
          } else if (/^(mededeling|communication|message)$/.test(key)) { if (!medParts.length) { if (val) medParts.push(val); mode = 'med'; } }
          else if (/^iban$/.test(key)) { if (!iban && val) iban = normIban(val); }
          else if (/^(verrichting|numero|transaction number)/.test(key)) entryId = val.replace(/\s+/g, '');
          else if (/^(valutadatum|date valeur|value date)$/.test(key)) valueDate = val;
          else if (!/^(persoonlijke info|info personnelle|personal info|bic|referentie|reference|kaartnummer|numero de carte|card number|datum|date|uur|heure|time)$/.test(key)) other.push(row);
          continue;
        }
        if (mode === 'name') { name = row; mode = null; continue; }
        if (mode === 'med') { if (medParts.length < 3 && norm(row) !== norm(medParts[0] || '')) medParts.push(row); continue; }
        other.push(row);
      }
      // Kaartbetaling zonder 'Naar:': de eerste gewone tekstregel is meestal de handelaar.
      if (!name) { const cand = other.find(r => !/:/.test(r) && /[a-z]{3}/i.test(r) && !/^(belgi[eë]|belgique|nederland|deutschland|france|luxembourg)$/i.test(r) && !/^instant op/i.test(r)); if (cand) { name = cand; other = other.filter(r => r !== cand); } }
      const med = dedupeWords(medParts.join(' '));
      txs.push({ date, amount: Math.round(amount * 100) / 100, name, iban, account, accountName: '', entryId, valueDate, currency,
        text: med || cleanSpaces(other.join(' ')), textLow: type + (med ? '' : '') });
    }
    return { txs, errors };
  }

  // --- Algemeen: rekeninguittreksel / verrichtingenlijst (datum links, bedrag rechts, omschrijving ertussen of eronder) ---
  const BAL_START = /(vorig|oud|begin|start|openings?|aanvangs)\s*saldo|saldo\s*(vorig|vorige|begin|start|bij aanvang|oud)|ancien solde|solde (precedent|initial|d'ouverture|de depart)|previous balance|opening balance|old balance|beginsaldo/;
  const BAL_END = /(nieuw|eind|slot|huidig)\s*saldo|saldo\s*(nieuw|einde|eind)|nouveau solde|solde final|new balance|closing balance|eindsaldo/;
  const SKIP_LINE = /^(pagina|page|blad|seite)\s*\d|\b(pagina|page|blad)\s*\d+\s*(\/|van|de|of)\s*\d+|^(totaal|total|subtotaal|sous-total|transport|over te dragen|report|a reporter)\b|^(dit document|ce document|this document)|\bbtw be\b|\btva be\b|\brpr\b|\bfsma\b/;
  // Kopregel van de tabel: zoek de kolomnamen (ook als meerdere kolomnamen in één cel zijn samengevoegd).
  function pdfFind(l, re) {
    for (const c of l.cells) {
      const t = c.text; const m = norm(t).match(re);
      if (!m) continue;
      const len = t.length || 1, w = c.x1 - c.x0;
      return { x0: c.x0 + w * (m.index / len), x1: c.x0 + w * ((m.index + m[0].length) / len), text: m[0] };
    }
    return null;
  }
  function pdfHeaderInfo(l) {
    const n = norm(l.text);
    if (n.length > 160 || pdfAmounts(l.text).length) return null;
    const hasDate = /\b(datum|boekingsdatum|boekdatum|transactiedatum|verrichtingsdatum|uitvoeringsdatum|date|jour)\b/.test(n);
    const hasDesc = /omschrijving|beschrijving|mededeling|description|libelle|details|tegenpartij|communication|naam\b/.test(n);
    const deb = pdfFind(l, /bedrag af(?: \(?debet\)?)?|\b(?:debet|debit|uitgaven|afschrijvingen|sorties)\b|(?:^|\s)af(?=\s|$)/);
    const cre = pdfFind(l, /bedrag bij(?: \(?credit\)?)?|\b(?:credit|ontvangsten|bijschrijvingen|entrees)\b|(?:^|\s)bij(?=\s|$)/);
    const amt = pdfFind(l, /\b(?:bedrag|montant|amount)\b(?: \(?(?:eur|€)\)?)?/);
    const bal = pdfFind(l, /\b(?:saldo|solde|balance)\b/);
    if (!(hasDate || hasDesc) || !((deb && cre) || amt || bal)) return null;
    return { deb: deb && cre ? deb : null, cre: deb && cre ? cre : null, amt, bal };
  }
  const center = c => (c.x0 + c.x1) / 2;
  function pdfLineAmounts(l) {
    const out = [];
    l.cells.forEach((c, ci) => {
      pdfAmounts(c.text).forEach(a => {
        // positie van dit bedrag binnen de cel (bedragen staan meestal rechts uitgelijnd)
        const len = c.text.length || 1;
        const x1 = a.end >= len - 1 ? c.x1 : c.x0 + (c.x1 - c.x0) * (a.end / len);
        const x0 = c.x0 + (c.x1 - c.x0) * (a.start / len);
        out.push(Object.assign({}, a, { ci, x0, x1, whole: a.start === 0 && a.end >= c.text.replace(/\s?(EUR|€)$/, '').length }));
      });
    });
    return out;
  }
  function stripTokens(text) {
    return cleanSpaces(String(text)
      .replace(PDF_AMT, ' ')
      .replace(/\(\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?\)/g, ' '));
  }
  function parseGenericPdf(lines, ctx) {
    const all = lines.map(l => l.text).join('\n');
    let header = null;
    const events = []; // {kind:'start'|'end'|'tx', ...}
    const txs = []; let errors = 0, guessed = 0, cur = null, headingDate = null, account = '';
    let prevRunBal = null; const balStart = [], balEnd = [];
    const ymdAll = [];
    const leftLimit = l => (l.width || 600) * 0.38;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const n = norm(l.text);
      if (i > 0 && lines[i - 1].page !== l.page && cur && !cur.pending) cur = null; // nieuwe pagina: geen vervolg van de vorige omschrijving
      const h = pdfHeaderInfo(l);
      if (h) { header = h; cur = null; continue; }
      if (!txs.length && !account) { const m = l.text.match(IBAN_IN); if (m && /rekening|compte|account|iban/i.test(l.text + ' ' + (lines[i - 1] ? lines[i - 1].text : ''))) account = normIban(m[1]); }
      let amts = pdfLineAmounts(l);
      // Saldo-regels
      if (amts.length && (BAL_START.test(n) || BAL_END.test(n) || (/\bsaldo\b|\bsolde\b|\bbalance\b/.test(n) && !pdfDate(l.cells[0].text, ctx) && !(l.cells[1] && pdfDate(l.cells[1].text, ctx))))) {
        // Eén regel kan zowel 'Vorig saldo' als 'Nieuw saldo' bevatten: neem per trefwoord het eerstvolgende bedrag.
        const tAmts = pdfAmounts(l.text);
        const nt = l.text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const found = [];
        [['start', BAL_START], ['end', BAL_END]].forEach(([kind, re]) => {
          const m = nt.match(re); if (!m) return;
          const a = tAmts.find(x => x.start >= m.index + m[0].length);
          if (a) found.push({ kind, at: m.index, value: Math.round((a.neg ? -a.value : a.value) * 100) / 100 });
        });
        if (!found.length) {
          const a = tAmts[tAmts.length - 1] || amts[amts.length - 1];
          found.push({ kind: events.some(e => e.kind === 'tx') ? 'end' : 'start', at: 0, value: Math.round((a.neg ? -a.value : a.value) * 100) / 100 });
        }
        found.sort((a, b) => a.at - b.at).forEach(f => { if (f.kind === 'start') balStart.push(f.value); else balEnd.push(f.value); if (f.kind === 'start' || !events.some(e => e.kind === 'tx')) events.push(f); else events.push(f); });
        cur = null; prevRunBal = found[found.length - 1].value; if (found.some(f => f.kind === 'start')) prevRunBal = found.find(f => f.kind === 'start').value; continue;
      }
      if (SKIP_LINE.test(n)) { continue; }
      // Datum links op de regel
      let lineDate = null, dateCells = 0, dateWhole = false, dateRest = '';
      let c0 = 0;
      if (l.cells.length > 1 && /^\d{1,4}\.?$/.test(l.cells[0].text) && l.cells[1].x0 < leftLimit(l)) c0 = 1; // volgnummer vooraan
      for (let ci = c0; ci < Math.min(c0 + 2, l.cells.length); ci++) {
        const c = l.cells[ci];
        if (c.x0 > leftLimit(l)) break;
        let d = pdfDate(c.text, ctx), rest = '';
        if (!d) {
          const words = c.text.split(' ');
          for (let w = Math.min(4, words.length - 1); w >= 1 && !d; w--) { d = pdfDate(words.slice(0, w).join(' '), ctx); if (d) rest = words.slice(w).join(' '); }
          if (d && ci > c0) d = null; // tweede datum alleen als hele cel
        }
        if (!d) break;
        if (!lineDate) { lineDate = d; dateWhole = !rest; }
        if (rest) { dateRest = rest; dateCells = ci + 1; break; }
        dateCells = ci + 1;
      }
      if (lineDate && !dateWhole && /^\d{1,2}[.:]\d{2}$/.test((l.cells[c0].text.split(' ')[0]) || '')) { lineDate = null; dateCells = 0; dateRest = ''; } // '19.02 uur' is een tijd
      const restCells = () => { const r = l.cells.slice(dateCells).map(c => c.text).filter(t => !pdfDate(t, ctx)); if (dateRest) r.unshift(dateRest); return r; };
      // Lopend saldo / saldo-kolom eruit
      let runBal = null;
      if (header && header.bal && amts.length > 1) {
        const bi = amts.reduce((best, a, k) => Math.abs(center(a) - center(header.bal)) < Math.abs(center(amts[best]) - center(header.bal)) ? k : best, 0);
        runBal = amts[bi]; amts = amts.filter((_, k) => k !== bi);
      }
      const onlyDate = lineDate && !amts.length && !cleanSpaces(restCells().join(' '));
      const relHead = !amts.length && l.cells.length === 1 && /^(vandaag|gisteren|aujourd'hui|hier|today|yesterday)$/i.test(l.cells[0].text) ? pdfDate(l.cells[0].text, ctx) : null;
      if (onlyDate || relHead) { headingDate = lineDate || relHead; cur = null; continue; }
      if (amts.length && (lineDate || headingDate)) {
        const a = amts[amts.length - 1];
        let sign = a.signed ? (a.neg ? -1 : 1) : 0;
        if (!sign && header && header.deb && header.cre) sign = Math.abs(center(a) - center(header.deb)) <= Math.abs(center(a) - center(header.cre)) ? -1 : 1;
        if (!sign && runBal && prevRunBal !== null) { const rb = runBal.neg ? -runBal.value : runBal.value; const diff = Math.round((rb - prevRunBal) * 100) / 100; if (Math.abs(Math.abs(diff) - a.value) < 0.005) sign = diff < 0 ? -1 : 1; }
        const desc = stripTokens(restCells().join(' '));
        cur = { date: lineDate || headingDate, value: a.value, sign, parts: desc ? [desc] : [], listStyle: !lineDate };
        txs.push(cur); events.push({ kind: 'tx', tx: cur });
        if (runBal) prevRunBal = runBal.neg ? -runBal.value : runBal.value;
        continue;
      }
      if (lineDate && dateWhole && !amts.length) { // datum en omschrijving, bedrag op de volgende regel
        cur = { date: lineDate, value: null, sign: 0, parts: [stripTokens(restCells().join(' '))].filter(Boolean), pending: true };
        continue;
      }
      if (amts.length && cur && cur.pending) {
        const a = amts[amts.length - 1];
        cur.value = a.value; cur.sign = a.signed ? (a.neg ? -1 : 1) : (header && header.deb && header.cre ? (Math.abs(center(a) - center(header.deb)) <= Math.abs(center(a) - center(header.cre)) ? -1 : 1) : 0);
        const d = stripTokens(l.text); if (d) cur.parts.push(d);
        delete cur.pending; txs.push(cur); events.push({ kind: 'tx', tx: cur });
        continue;
      }
      if (amts.length && !lineDate && !headingDate) { if (txs.length || cur) errors++; continue; }
      if (cur && !amts.length && cur.parts.length < 8) { const d = stripTokens(l.text); if (d) cur.parts.push(d); }
    }
    // Teken: geen +/− en geen af/bij-kolommen → afleiden uit de saldo's, anders uit de omschrijving.
    const fin = txs.filter(t => t.value !== null && t.value > 0);
    fin.forEach(t => {
      if (t.sign) return;
      guessed++;
      const s = norm(t.parts.join(' '));
      t.sign = /\b(van|de la part de|from|storting|ontvangen|bijschrijving|salaris|loon|wedde|terugbetaling|refund|remboursement|rente|interest|credit)\b|^van:|overschrijving van/.test(s) ? 1 : -1;
    });
    // Lijst (datum als tussenkop): eerste regel = tegenpartij, de rest = omschrijving.
    const out = fin.map(t => ({ date: t.date, amount: Math.round(t.sign * t.value * 100) / 100, name: t.listStyle && t.parts.length && !/:/.test(t.parts[0]) ? t.parts[0].slice(0, 80) : '', iban: '', account, accountName: '', entryId: '', currency: 'EUR',
      text: cleanSpaces((t.listStyle && t.parts.length && !/:/.test(t.parts[0]) ? t.parts.slice(1) : t.parts).join(' ')).slice(0, 400), textLow: '' }));
    // Saldo-controle per uittreksel: begin + som = eind.
    const segs = []; let seg = null;
    events.forEach(e => {
      if (e.kind === 'start') { seg = { start: e.value, sum: 0, n: 0 }; }
      else if (e.kind === 'tx') { if (!seg) seg = { start: null, sum: 0, n: 0 }; if (e.tx.value) { seg.sum += e.tx.sign * e.tx.value; seg.n++; } }
      else if (e.kind === 'end') { if (seg) { seg.end = e.value; segs.push(seg); } seg = null; }
    });
    // Alleen saldo's zonder teken? Dan proberen of de check klopt met omgekeerde tekens is niet zinvol; we melden gewoon.
    let usable = segs.filter(s => s.start !== null && s.end !== undefined && s.n > 0);
    // Begin- en eindsaldo bovenaan (vóór de transacties): controleer het hele document in één keer.
    if (!usable.length && balStart.length === 1 && balEnd.length === 1 && fin.length) {
      usable = [{ start: balStart[0], end: balEnd[0], sum: fin.reduce((a, t) => a + t.sign * t.value, 0), n: fin.length }];
    }
    const checks = usable.map(s => ({ start: s.start, end: s.end, sum: Math.round(s.sum * 100) / 100, n: s.n, ok: Math.abs(s.start + s.sum - s.end) < 0.005, diff: Math.round((s.end - s.start - s.sum) * 100) / 100 }));
    return { txs: out, errors, guessed, balance: checks.length ? checks : null };
  }

  // doc: { pages: [{ width, height, items: [{ str, x, y, w, h }] }], created: 'D:2026…' }
  function parsePdf(doc) {
    const lines = pdfLines(doc);
    if (!lines.length) return { error: 'Deze PDF bevat geen leesbare tekst (waarschijnlijk een scan of foto). Download bij je bank een PDF-afschrift of een CSV-bestand.' };
    const all = lines.map(l => l.text).join('\n');
    const bank = pdfBank(all);
    // Referentiedatum voor datums zonder jaar: 'gegenereerd op …', anders de aanmaakdatum van de PDF, anders de laatste volledige datum.
    let ref = null; const g = all.match(/(?:gegenereerd op|genere le|generated on|datum afschrift|date de l'extrait|afgedrukt op|imprime le)\s*:?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4})/i);
    if (g) ref = parseDate(g[1], 'dmy');
    const relative = /^(vandaag|gisteren|aujourd'hui|hier|today|yesterday)$/im.test(lines.map(l => norm(l.text)).join('\n'));
    if (!ref && relative) ref = pdfYmdFromMeta(doc.created);
    if (!ref) { const ds = (all.match(/\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}\b/g) || []).map(x => parseDate(x, 'dmy')).filter(Boolean).sort(); ref = ds[ds.length - 1] || null; }
    if (!ref) ref = pdfYmdFromMeta(doc.created);
    const ctx = { ref };
    let res, kind;
    if (/^(details transactie|detail(s)? de la transaction|transaction details)$/m.test(lines.map(l => norm(l.text)).join('\n'))) {
      res = parseIngDetailPdf(lines); kind = 'transactiedetails';
    }
    if (!res || !res.txs.length) { res = parseGenericPdf(lines, ctx); kind = 'afschrift'; }
    if (!res.txs.length) {
      return { error: 'In deze PDF zijn geen transacties gevonden. Kies een rekeninguittreksel, een overzicht van je verrichtingen of de transactiedetails uit je bank-app, of download bij je bank een CSV-bestand.' };
    }
    return { format: 'PDF', pdfKind: kind, bank, txs: res.txs, errors: res.errors || 0, guessedSigns: res.guessed || 0, balance: res.balance || null };
  }

  // pdf.js → { pages, created }. lib = window.pdfjsLib (browser) of pdfjs-dist (tests).
  async function pdfExtract(lib, data) {
    const task = lib.getDocument({ data: data instanceof Uint8Array ? data : new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, disableAutoFetch: true, disableStream: true, stopAtErrors: false });
    const pdf = await task.promise;
    let created = null;
    try { const md = await pdf.getMetadata(); created = md && md.info && (md.info.CreationDate || md.info.ModDate) || null; } catch (e) { /* geen metadata */ }
    const pages = [];
    const max = Math.min(pdf.numPages, 200);
    for (let p = 1; p <= max; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const view = page.view || [0, 0, 600, 800];
      pages.push({ width: view[2] - view[0], height: view[3] - view[1], items: tc.items.filter(it => typeof it.str === 'string').map(it => ({ str: it.str, x: it.transform[4] - view[0], y: it.transform[5] - view[1], w: it.width, h: it.height || Math.abs(it.transform[3]) })) });
      if (page.cleanup) page.cleanup();
    }
    try { await pdf.destroy(); } catch (e) {}
    return { pages, created, numPages: pdf.numPages };
  }
  function isPdfBytes(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const n = Math.min(b.length, 1024);
    for (let i = 0; i < n - 4; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2D) return true;
    return false;
  }

  // ==================== OMSCHRIJVING & TEGENPARTIJ ====================
  // Haal de tegenpartij uit vrije tekst: 'Naar: X - BE..', 'Van: X', 'Naam: X', '/NAME/X/', kaartbetalingen, ABN 'BEA'.
  function extractName(text) {
    const t = cleanSpaces(text);
    if (!t) return '';
    let m;
    const stop = '(?=\\s+-\\s+[A-Z]{2}\\d{2}|\\s+[A-Z]{2}\\d{2}[A-Z0-9]{8,}|\\s+(?:IBAN|BIC|Mededeling|Omschrijving|Kenmerk|Referentie|Valutadatum|Machtiging|Machtiging ID|Incassant ID|Communication|Communicatie|Bericht|Datum|Adres|Uitvoeringsdatum)\\b|\\s*$)';
    if ((m = t.match(new RegExp('(?:^|\\s)(?:Naar|Van|Ten gunste van|Ten voordele van|Naam|Name|Begunstigde|Opdrachtgever|B[ée]n[ée]ficiaire|Donneur d\'ordre|De|Vers|Payee)\\s*:\\s*(.+?)' + stop, 'i')))) {
      const v = cleanSpaces(m[1]).replace(/\s+-$/, '');
      if (v && !looksLikeIban(v)) return v.slice(0, 80);
    }
    if ((m = t.match(/\/NAME\/([^/]+)\//))) return cleanSpaces(m[1]).slice(0, 80);
    if ((m = t.match(/(?:BEA|GEA|eCom|CCV)[,\s]+(?:Betaalpas|Apple Pay|Google Pay|Garmin Pay|Fitbit Pay)?\s*(.+?),\s*PAS\d*/i))) return cleanSpaces(m[1]).slice(0, 80);
    // Kaartbetaling (o.a. ING België/KBC/Belfius): 'Betaling met debetkaart nummer 4871 04XX XXXX 1234 COLRUYT HAMONT 25/10 ...'
    if ((m = t.match(/(?:kaart|card|carte|bancontact|maestro|visa|mastercard|apple pay|google pay|payconiq)\b[^0-9]{0,30}?(?:nummer|nr\.?|n°|number|numero)?\s*[\dX*]{4}[\dX* ]{6,}\s+(.+?)(?=\s+\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b|\s+om\s+\d|\s+(?:a|à|at)\s+\d{1,2}[.:h]\d{2}|\s+(?:Valutadatum|Datum|Date|Referentie|Ref)\b|\s*$)/i))) {
      const v = cleanSpaces(m[1]).replace(/\s+(?:BE|NL|DE|FR|LU)$/i, '');
      if (v) return v.slice(0, 80);
    }
    return '';
  }
  // Generieke banktekst ('Betaling met debetkaart', 'Doorlopende betalingsopdracht...') is geen goede omschrijving.
  const GENERIC = /^(betaling met (debet|bancontact|maestro|visa|krediet)?kaart|betaling bancontact|bancontact( betaling)?|europese domiciliering|europese overschrijving|overschrijving|doorlopende betalingsopdracht.*|domiciliering|instantoverschrijving.*|paiement.*|virement.*|domiciliation.*|ordre permanent.*|card payment|sepa .*|incasso|ideal|betaalautomaat|geldautomaat|online bankieren|internetbankieren|diversen|europese incasso|geldopneming.*|cash withdrawal|retrait.*)$/i;
  function cleanText(s) {
    return cleanSpaces(String(s || '')
      .replace(/\b(?:IBAN|BIC|Kenmerk|Referentie|Machtiging ID|Incassant ID|Valutadatum|Verrichtingnummer|Verrichtingsnummer|Batch ID)\s*:\s*\S+/gi, ' ')
      .replace(/\b(?:Naam|Omschrijving|Mededeling|Bericht|Naar|Van)\s*:\s*/gi, ' ')
      .replace(/\s+-\s+[A-Z]{2}\d{2}[A-Z0-9]{8,}/g, ' ')
      .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, ' ')
      .replace(/\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?\b/g, ' '));
  }
  function omschrijvingFrom(text) {
    const t = cleanSpaces(text);
    let m = t.match(/\/REMI\/(?:USTD\/\/|STRD\/CUR\/|STRD\/\/)?(.*?)(?:\/(?:EREF|ORDP|BENM|CSID|MARF|ISDT|ULTD|ULTC|SVCL|PURP|IBAN|BIC|NAME)\/|\/?$)/);
    if (m) return cleanSpaces(m[1]);
    m = t.match(/(?:Omschrijving|Mededeling|Bericht|Communication|Communicatie|Description)\s*:\s*(.+?)(?=\s+(?:IBAN|BIC|Kenmerk|Referentie|Machtiging|Incassant|Valutadatum|Naam|Name|Datum)\b\s*:|\s*$)/i);
    return m ? cleanSpaces(m[1]) : '';
  }
  // Kaart-/automaattekst zonder informatie ('Betaling met debetkaart nummer 4871 04XX ... om 14.32 uur', 'Pasvolgnr: 008 ...').
  function stripBoilerplate(s, name) {
    let t = ' ' + cleanSpaces(s) + ' ';
    t = t.replace(/\b(?:betaling|paiement|payment|geldopneming|retrait|aankoop|achat)\s+(?:met|par|by|via)?\s*(?:de\s+)?(?:debetkaart|kredietkaart|bancontact|maestro|visa|mastercard|carte de d[ée]bit|debit card|kaart|card|carte)\s*(?:nummer|nr\.?|n°|num[ée]ro|number)?\s*[\dX* ]{0,24}/gi, ' ')
      .replace(/\b(?:Pasvolgnr|Card sequence no\.?|Transactie|Term|Transaction|NR|PAS\d*)\s*:?\s*\S+/gi, ' ')
      .replace(/\b(?:debit|credit) card payment\s*(?:number|no\.?)?\s*[\dX* ]{0,24}/gi, ' ')
      .replace(/\b(?:BEA|GEA|eCom|CCV),?\s/g, ' ').replace(/\s\/(?=\s)/g, ' ')
      .replace(/\bReferentie bank\s*:\s*\S+/gi, ' ')
      .replace(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?(?:\s*(?:om|à|a|at)?\s*\d{1,2}[.:h]\d{2}(?:\s*uur)?)?\b/gi, ' ')
      .replace(/\b\d{1,2}[.:]\d{2}(?:\s*uur)?\b/g, ' ')
      .replace(/\b(?:om|à|uur|Bancontact|Apple Pay|Google Pay|Payconiq)\b/gi, ' ');
    if (name) t = t.split(name).join(' ').replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
    return cleanSpaces(t.replace(/(^|\s)[\/,.:;-]+(?=\s|$)/g, ' '));
  }
  // Herhaalde stukken weg ('Salaris september Salaris september' → 'Salaris september').
  function dedupeWords(s) {
    const words = cleanSpaces(s).split(' ');
    for (let len = Math.floor(words.length / 2); len >= 2; len--) {
      for (let i = 0; i + 2 * len <= words.length; i++) {
        const a = words.slice(i, i + len).join(' ').toLowerCase(), b = words.slice(i + len, i + 2 * len).join(' ').toLowerCase();
        if (a === b) { words.splice(i + len, len); return dedupeWords(words.join(' ')); }
      }
    }
    return words.join(' ');
  }
  function cardMerchant(text) {
    const t = cleanSpaces(text);
    const m = t.match(/(?:bancontact|debetkaart|maestro|kaart|debit card|carte de d[ée]bit)\s+(?:nummer\s+)?(?:[\dX*]{4}[\dX* ]{6,}\s+)?(?:\d{1,2}[-\/.]\d{1,2}(?:[-\/.]\d{2,4})?\s+)?(?:(?:om\s+)?\d{1,2}[.:]\d{2}(?:\s*uur)?\s+)?([A-Za-z].{1,60}?)(?=\s+\d{1,2}[\/.-]\d{1,2}\b|\s*$)/i);
    return m ? cleanSpaces(m[1]) : '';
  }
  const CASH_RE = /geldopneming|geldopname|geldautomaat|retrait|cash withdrawal|atm\b/i;
  // Maakt van een ruwe bankregel: description (wat in de app komt), note (extra info) en een sleutel voor de tegenpartij.
  function describe(tx) {
    let name = cleanSpaces(tx.name);
    const text = cleanSpaces(tx.text);
    const all = cleanSpaces(text + ' ' + (tx.textLow || ''));
    if (!name || looksLikeIban(name)) name = extractName(text) || extractName(tx.textLow) || cardMerchant(all) || '';
    name = name.replace(/^\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\s+/, '').replace(/^(?:om\s+)?\d{1,2}[.:]\d{2}(?:\s*uur)?\s+/, '');
    if (/^\d+$/.test(name)) name = '';
    if (CASH_RE.test(all) && !/^geldop/i.test(name)) name = 'Geldopname' + (name ? ' ' + name : '');
    let note = omschrijvingFrom(text);
    if (!note) note = cleanText(stripBoilerplate(dedupeWords(text), cleanSpaces(tx.name) || name));
    note = dedupeWords(note);
    if (note && name && norm(note).startsWith(norm(name))) note = cleanSpaces(note.slice(name.length));
    if (GENERIC.test(note) || /^[\W\d]*$/.test(note) || /^(naar|van|to|from|de|vers|aan)$/i.test(note)) note = '';
    let description = name;
    if (!description) {
      const low = cleanText(tx.textLow);
      description = note && !GENERIC.test(note) ? note : (low || note || 'Banktransactie');
      if (description === note) note = '';
    }
    // Mooier hoofdlettergebruik voor namen in kapitalen ('ALBERT HEIJN 1234' → 'Albert Heijn 1234').
    if (description === description.toUpperCase() && /[A-Z]{3}/.test(description)) {
      description = description.toLowerCase().replace(/(^|[\s\-/&(.])([a-zà-ÿ])/g, (a, p, c) => p + c.toUpperCase()).replace(/\bIng\b/, 'ING');
    }
    description = description.slice(0, 80);
    const key = counterpartyKey(name || description, tx.iban);
    return { description, note: note.slice(0, 160), key };
  }
  function counterpartyKey(name, iban) {
    const n = norm(name).replace(/\b(nv|bv|b\.v\.|sa|bvba|srl|vof)\b/g, '').replace(/[0-9]+/g, ' ').replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (n && n !== 'banktransactie') return 'n:' + n.split(' ').slice(0, 4).join(' ');
    return iban ? 'i:' + normIban(iban) : '';
  }

  // ==================== HOOFDFUNCTIE ====================
  function detectFormat(text) {
    const head = text.slice(0, 4000);
    if (/<\?xml|<Document[\s>]/i.test(head) && /BkToCstmrStmt|camt\.05[234]/i.test(text.slice(0, 20000))) return 'camt';
    if (/^:20:/m.test(head) && /^:61:/m.test(text)) return 'mt940';
    if (/^\{1:/.test(head.trim()) && /:61:/.test(text)) return 'mt940';
    if (/^\s*</.test(head)) return 'xml-unknown';
    if (/^%PDF/.test(head)) return 'pdf';
    if (/^PK/.test(head)) return 'zip';
    return 'csv';
  }
  function parseText(text, forcedMap) {
    const fmt = detectFormat(text);
    let res;
    if (fmt === 'camt') res = parseCamt(text);
    else if (fmt === 'mt940') res = parseMt940(text);
    else if (fmt === 'pdf') return { error: 'Dit is een PDF; die wordt apart gelezen. Probeer het bestand opnieuw te kiezen.' };
    else if (fmt === 'zip') return { error: 'Dit lijkt een Excel- of zip-bestand. Kies bij je bank CSV als bestandsformaat.' };
    else if (fmt === 'xml-unknown') return { error: 'Dit XML-bestand is geen CAMT.053-rekeningafschrift.' };
    else res = parseCsvText(text, forcedMap);
    if (res.error || res.needsMapping) return res;
    return finalize(res);
  }
  // PDF: zelfde nabewerking als CSV (omschrijving, eigen rekeningen, importsleutels).
  function parsePdfDoc(doc) {
    const res = parsePdf(doc);
    if (res.error) return res;
    return finalize(res);
  }
  function finalize(res) {
    // Alleen euro's: transacties in een andere munt worden overgeslagen (worden in de preview gemeld).
    const foreign = res.txs.filter(t => t.currency && t.currency !== 'EUR' && /^[A-Z]{3}$/.test(t.currency));
    res.txs = res.txs.filter(t => !foreign.includes(t));
    res.foreign = foreign.length;
    res.txs.forEach(t => Object.assign(t, describe(t)));
    // Eigen rekeningen in dit bestand (bijv. ING 'alle rekeningen'): overboekingen daartussen herkennen.
    const own = new Set(res.txs.map(t => t.account).filter(Boolean));
    res.txs.forEach(t => { t.ownTransfer = !!(t.iban && own.has(t.iban) && t.iban !== t.account); });
    // Importsleutel: zelfde bankregel = zelfde sleutel, ook bij opnieuw importeren (volgnummer voor identieke regels).
    const seen = {};
    res.txs.forEach(t => {
      const base = (t.entryId ? 'e:' + t.account + ':' + t.entryId + ':' : '') + t.date + '|' + t.amount.toFixed(2) + '|' + norm(t.name + ' ' + t.text + ' ' + t.textLow).slice(0, 120);
      // Met een volgnummer van de bank is dezelfde sleutel echt dezelfde boeking; zonder volgnummer tellen we identieke regels.
      seen[base] = t.entryId ? 1 : (seen[base] || 0) + 1;
      t.importKey = simpleHash(base) + '-' + seen[base];
      // v37: banksleutel (rekening + verrichtingnummer + datum + bedrag): herkent dezelfde boeking uit CSV én PDF.
      const vr = (String(t.text + ' ' + t.textLow).match(/Verrichting(?:s)?nummer\s*:?\s*(\d+)/i) || [])[1] || (String(t.entryId || '').match(/\d+/g) || []).pop() || '';
      t.bankKey = vr && t.account ? 'b' + simpleHash(t.account + '|' + String(+vr) + '|' + t.date + '|' + t.amount.toFixed(2)) : '';
    });
    return res;
  }
  function simpleHash(s) {
    let h1 = 0x811c9dc5, h2 = 0x1000193;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 + c, 2654435761) >>> 0; }
    return h1.toString(36) + h2.toString(36);
  }

  // ==================== CATEGORIEËN ====================
  const RULES = [
    { cat: 'Boodschappen', type: 'expense', kw: ['albert heijn', 'ah to go', 'jumbo', 'lidl', 'aldi', 'colruyt', 'delhaize', 'carrefour', 'okay ', 'spar ', 'intermarche', 'dirk van den broek', 'dirk ', 'vomar', 'hoogvliet', 'plus ', 'coop ', 'picnic', 'crisp', 'ekoplaza', 'match ', 'cora ', 'bio-planet', 'bioplanet', 'louis delhaize', 'proxy delhaize', 'albert heijn', 'boucherie', 'slagerij', 'slager', 'groenten', 'kaashandel', 'nettorama', 'deen ', 'poiesz', 'jan linders'], re: /\bah\b|\bplus\b|\bspar\b|\bokay\b/ },
    { cat: 'Eten & Drinken', type: 'expense', kw: ['mcdonald', 'burger king', 'kfc', 'domino', 'thuisbezorgd', 'takeaway', 'uber eats', 'ubereats', 'deliveroo', 'starbucks', 'restaurant', 'frituur', 'frietkot', 'friture', 'pizza', 'bakkerij', 'bakker', 'brasserie', 'cafe ', 'café', 'eetcafe', 'lunchroom', 'subway', 'new york pizza', 'febo', 'quick ', 'panos', 'exki', 'le pain quotidien', 'kebab', 'sushi', 'snackbar', 'ijssalon'] },
    { cat: 'Vervoer', type: 'expense', kw: ['shell', 'esso', 'texaco', 'totalenergies', 'total ', 'q8', 'tinq', 'tango', 'dats 24', 'dats24', 'lukoil', 'gulf ', 'avia ', 'ns.nl', 'ns groep', 'ns reizigers', 'nmbs', 'sncb', 'de lijn', 'ov-chipkaart', 'ov chipkaart', 'translink', 'parkeren', 'parking', 'q-park', 'interparking', 'yellowbrick', 'easypark', 'parkmobile', '4411', 'supercharger', 'ionity', 'fastned', 'allego', 'shell recharge', 'electra', 'tankstation', 'uber ', 'bolt.eu', 'bolt ', 'arval', 'anwb', 'touring', 'vab ', 'kwik-fit', 'carglass', 'autowas', 'carwash', 'car wash', 'blue bike', 'swapfiets', 'bp '], re: /\bbp\b|\bns\b/ },
    { cat: 'Wonen', type: 'expense', kw: ['huur', 'hypotheek', 'immopunt', 'makelaar', 'immo ', 'vastgoed', 'woonstichting', 'woningcorporatie', 'eneco', 'vattenfall', 'essent', 'engie', 'luminus', 'fluvius', 'pidpa', 'de watergroep', 'water-link', 'farys', 'brabant water', 'vitens', 'evides', 'budget energie', 'greenchoice', 'mega ', 'bolt energie', 'energie', 'gemeentebelasting', 'waterschap', 'gemeente', 'ikea', 'gamma', 'praxis', 'karwei', 'hornbach', 'brico', 'hubo', 'action ', 'leen bakker', 'kwantum', 'jysk', 'blokker', 'hema', 'woonverzekering', 'brandverzekering', 'inboedel'] },
    { cat: 'Abonnementen', type: 'expense', kw: ['netflix', 'spotify', 'disney', 'videoland', 'youtube', 'apple.com', 'itunes', 'icloud', 'google one', 'google *', 'telenet', 'proximus', 'orange belgium', 'orange ', 'mobile vikings', 'base ', 'scarlet', 'kpn', 'ziggo', 'odido', 't-mobile', 'vodafone', 'tele2', 'simyo', 'lebara', 'amazon prime', 'prime video', 'hbo', 'max.com', 'streamz', 'chatgpt', 'openai', 'patreon', 'basic-fit', 'basic fit', 'sportschool', 'fitness', 'audible', 'kindle', 'dropbox', 'microsoft', 'adobe', 'playstation plus', 'xbox game pass', 'nintendo switch online', 'abonnement'] },
    { cat: 'Kleding', type: 'expense', kw: ['zalando', 'h&m', 'primark', 'c&a', 'zeeman', 'wehkamp', 'about you', 'shein', 'nike', 'adidas', 'jbc', 'zara', 'bershka', 'pull&bear', 'only ', 'jack & jones', 'we fashion', 'score ', 'bristol', 'schoenen', 'torfs', 'van haren', 'decathlon', 'kiabi', 'e5 mode', 'vinted', 'esprit', 'tommy hilfiger', 'scapino', 'bobbi'] , re: /\bhm\b|\bh & m\b/ },
    { cat: 'Gezondheid', type: 'expense', kw: ['apotheek', 'pharmacie', 'farmacie', 'tandarts', 'huisarts', 'ziekenhuis', 'kliniek', 'dokter', 'cm ', 'christelijke mutualiteit', 'mutualiteit', 'mutualite', 'ziekenfonds', 'helan', 'partena', 'solidaris', 'zilveren kruis', 'vgz', 'menzis', 'cz zorg', 'ohra', 'kruidvat', 'etos', 'da drogist', 'trekpleister', 'fysio', 'kinesist', 'kine ', 'opticien', 'pearle', 'hans anders', 'specsavers', 'gezondheid', 'medi-market', 'medimarket'], re: /\bcz\b|\bcm\b/ },
    { cat: 'Entertainment', type: 'expense', kw: ['kinepolis', 'pathe', 'pathé', 'vue ', 'bioscoop', 'cinema', 'steam', 'playstation', 'nintendo', 'xbox', 'efteling', 'walibi', 'plopsa', 'bobbejaanland', 'pairi daiza', 'toverland', 'concert', 'ticketmaster', 'eventbrite', 'bol.com', 'coolblue', 'mediamarkt', 'fnac', 'amazon', 'bowling', 'escape', 'museum', 'dierentuin', 'zoo '] },
    { cat: 'Salaris', type: 'income', kw: ['salaris', 'loon', 'salary', 'wedde', 'payroll', 'netto loon', 'maandloon', 'vakantiegeld', 'eindejaarspremie', 'dertiende maand', 'uwv', 'rva ', 'werkloosheid'] },
    { cat: 'Terugbetaling', type: 'income', kw: ['terugbetaling', 'refund', 'retour', 'restitutie', 'teruggave', 'terugstorting', 'remboursement', 'creditnota', 'tikkie', 'betaalverzoek', 'mutualiteit', 'ziekenfonds', 'zorgverzekeraar', 'cm ', 'helan', 'belastingdienst', 'fod financien', 'spf finances'], re: /\bcm\b/ },
    { cat: 'Cadeau', type: 'income', kw: ['cadeau', 'gift', 'verjaardag', 'kado', 'geschenk'] }
  ];
  const SAVINGS_RE = /spaarrekening|spaar ?rek|oranje spaar|\bsparen\b|naar sparen|van sparen|epargne|compte d'epargne|savings|spaardoel|eigen rekening|own account|interne overboeking|overboeking eigen/;

  function matchRule(t, type) {
    const hay = ' ' + norm([t.description, t.name, t.text, t.textLow, t.note].join(' ')) + ' ';
    for (const r of RULES) {
      if (r.type !== type) continue;
      if (r.kw.some(k => hay.includes(k.endsWith(' ') ? ' ' + k : k)) || (r.re && r.re.test(hay))) return r.cat;
    }
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parsePdf, parsePdfDoc, pdfExtract, pdfLines, pdfDate, pdfAmounts, isPdfBytes, parseText, parseCsv, parseCsvText, parseAmount, parseDate, detectDelimiter, decodeBytes, extractName, describe, counterpartyKey, matchRule, detectFormat, SAVINGS_RE, RULES, norm, mapColumns, rowsToTransactions };
  }
  root.MGBank = { parsePdfDoc, pdfExtract, isPdfBytes, parseText, parseCsv, parseAmount, parseDate, decodeBytes, extractName, describe, counterpartyKey, matchRule, SAVINGS_RE, norm, rowsToTransactions, mappingComplete };
})(typeof window !== 'undefined' ? window : globalThis);

// ==================== SCHERM: BANKBESTAND IMPORTEREN ====================
// Gebruikt de gewone app-functies (state, saveState, render, ...) zodat geïmporteerde transacties precies zo
// meetellen als handmatig toegevoegde: in de juiste periode, in Analyse, in het saldo en via saveState ook in de cloud-sync.
var bankImport = null;
const BI_MAX_BYTES = 15 * 1024 * 1024;

function biEl(id) { return document.getElementById(id); }
function biStage(name) {
  ['intro', 'mapping', 'preview', 'done'].forEach(s => { const el = biEl('bi-' + s); if (el) el.classList.toggle('hidden', s !== name); });
  const foot = biEl('bi-footer'); if (foot) foot.classList.toggle('hidden', name !== 'preview');
  const modal = biEl('modal-bank-import');
  if (modal) modal.querySelectorAll('.overflow-y-auto').forEach(el => { el.scrollTop = 0; });
}
function biSetError(msg) {
  const el = biEl('bi-error');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

function openBankImport() {
  bankImport = null;
  biSetError('');
  biStage('intro');
  const wasOpen = !!document.querySelector('.modal.open');
  if (wasOpen) { closeModal({ keepScroll: true }); setTimeout(() => openModal('bank-import'), 200); }
  else openModal('bank-import');
}
function biPickFile() {
  const input = biEl('bank-file');
  input.value = '';
  input.click();
}
function biReadFile(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}
// v37: pdf.js pas laden als er een PDF gekozen wordt (lokaal in vendor/pdfjs, geen CDN).
var biPdfLibPromise = null;
function biLoadPdfJs() {
  if (window.pdfjsLib && window.pdfjsLib.getDocument) return Promise.resolve(window.pdfjsLib);
  if (biPdfLibPromise) return biPdfLibPromise;
  biPdfLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/pdfjs/pdf.min.js';
    s.async = true;
    s.onload = () => {
      const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
      if (!lib || !lib.getDocument) { biPdfLibPromise = null; reject(new Error('pdfjs')); return; }
      lib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
      resolve(lib);
    };
    s.onerror = () => { biPdfLibPromise = null; s.remove(); reject(new Error('pdfjs-load')); };
    document.head.appendChild(s);
  });
  return biPdfLibPromise;
}
function biBusy(on, text) {
  const el = biEl('bi-busy');
  if (el) { el.textContent = text || ''; el.classList.toggle('hidden', !on); }
  const btn = document.querySelector('#bi-intro button[onclick="biPickFile()"]');
  if (btn) { btn.disabled = !!on; btn.classList.toggle('opacity-50', !!on); }
}
async function biHandleFiles(input) {
  const files = Array.from((input && input.files) || []);
  if (input) input.value = '';
  if (!files.length) return;
  biSetError('');
  const texts = [];
  try {
    for (const f of files) {
      if (f.size > BI_MAX_BYTES) { biSetError(`"${f.name}" is te groot (max. 15 MB).`); return; }
      let buf;
      try { buf = await biReadFile(f); }
      catch (e) { biSetError(`"${f.name}" kon niet worden gelezen.`); return; }
      if (MGBank.isPdfBytes(buf) || /\.pdf$/i.test(f.name)) {
        if (!MGBank.isPdfBytes(buf)) { biSetError(`"${f.name}" is geen geldige PDF.`); return; }
        biBusy(true, files.length > 1 ? `PDF's lezen… (${texts.length + 1}/${files.length})` : 'PDF lezen…');
        let lib;
        try { lib = await biLoadPdfJs(); }
        catch (e) { biSetError('De PDF-lezer kon niet worden geladen. Controleer je internetverbinding en probeer het opnieuw.'); return; }
        try { texts.push({ name: f.name, pdf: await MGBank.pdfExtract(lib, new Uint8Array(buf)) }); }
        catch (e) {
          const pw = e && (e.name === 'PasswordException' || /password/i.test(e.message || ''));
          biSetError(pw ? `"${f.name}" is beveiligd met een wachtwoord. Bewaar het afschrift zonder wachtwoord en probeer opnieuw.` : `"${f.name}" kon niet als PDF worden gelezen (beschadigd of onbekend formaat).`);
          return;
        }
      } else texts.push({ name: f.name, text: MGBank.decodeBytes(buf) });
    }
  } finally { biBusy(false); }
  biProcessTexts(texts);
}
// texts: [{ name, text }]. Los aan te roepen (ook vanuit tests).
function biProcessTexts(texts) {
  const results = [];
  for (const t of texts) {
    const res = t.pdf ? MGBank.parsePdfDoc(t.pdf) : MGBank.parseText(t.text);
    if (res.error) { biSetError(`${t.name}: ${res.error}`); return false; }
    if (res.needsMapping) {
      if (t.pdf) { biSetError(`${t.name}: in deze PDF zijn geen transacties gevonden.`); return false; }
      if (texts.length > 1) { biSetError(`${t.name}: dit formaat werd niet herkend. Kies dit bestand apart om de kolommen zelf aan te wijzen.`); return false; }
      biOpenMapping(t, res);
      return 'mapping';
    }
    results.push({ name: t.name, res });
  }
  biFinishParse(results);
  return true;
}
function biFinishParse(results) {
  const txs = [];
  let foreign = 0, unreadable = 0, guessed = 0;
  const formats = new Set(), balance = [];
  results.forEach(({ name, res }) => {
    foreign += res.foreign || 0; unreadable += res.errors || 0; guessed += res.guessedSigns || 0;
    formats.add(res.bank ? `${res.format} (${res.bank})` : res.format);
    if (res.balance) balance.push(...res.balance);
    res.txs.forEach(t => { t.file = name; });
    txs.push(...res.txs);
  });
  if (!txs.length) { biSetError('Er zijn geen transacties in dit bestand gevonden.' + (unreadable ? ` (${unreadable} regels konden niet worden gelezen.)` : '')); biStage('intro'); return; }
  biBuildPreview(txs, { formats: [...formats], foreign, unreadable, guessed, balance, files: results.map(r => r.name) });
}

// ---------- Kolommen zelf aanwijzen ----------
function biOpenMapping(file, res) {
  const rows = res.rows;
  bankImport = { pending: { name: file.name, text: file.text, rows } };
  const width = Math.max(...rows.slice(0, 20).map(r => r.length));
  const hasHeader = res.headerRow >= 0;
  const start = hasHeader ? res.headerRow + 1 : 0;
  const sample = rows.slice(start, start + 3);
  const head = hasHeader ? rows[res.headerRow] : null;
  const label = i => {
    const h = head && head[i] ? head[i] : `Kolom ${i + 1}`;
    const ex = sample.map(r => r[i]).filter(Boolean)[0] || '';
    return `${h}${ex ? ' – ' + String(ex).slice(0, 28) : ''}`;
  };
  const guess = test => { for (let i = 0; i < width; i++) { const v = sample.map(r => r[i]).filter(Boolean); if (v.length && v.every(test)) return i; } return -1; };
  const dateG = guess(v => !!MGBank.parseDate(v));
  const amtG = (() => { for (let i = 0; i < width; i++) { if (i === dateG) continue; const v = sample.map(r => r[i]).filter(Boolean); if (v.length && v.every(x => MGBank.parseAmount(x) !== null && /[.,]\d{1,2}\s*$|^-?\d+$/.test(String(x).trim()))) return i; } return -1; })();
  const descG = (() => { for (let i = 0; i < width; i++) { if (i === dateG || i === amtG) continue; const v = sample.map(r => r[i]).filter(Boolean); if (v.length && v.some(x => /[a-z]{3}/i.test(x))) return i; } return -1; })();
  const opts = (sel, optional) => (optional ? `<option value="-1">— geen —</option>` : '') +
    Array.from({ length: width }, (_, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${escapeHtml(label(i))}</option>`).join('');
  biEl('bi-map-date').innerHTML = opts(dateG, false);
  biEl('bi-map-amount').innerHTML = opts(amtG, false);
  biEl('bi-map-desc').innerHTML = opts(descG, true);
  biEl('bi-map-name').innerHTML = opts(-1, true);
  biEl('bi-map-sign').innerHTML = opts(-1, true);
  biEl('bi-map-header').checked = hasHeader;
  biEl('bi-map-file').textContent = file.name;
  biEl('bi-map-preview').innerHTML = rows.slice(0, 4).map(r => `<div class="bi-maprow">${r.map(c => `<span>${escapeHtml(String(c).slice(0, 24))}</span>`).join('')}</div>`).join('');
  biStage('mapping');
}
function biApplyMapping(e) {
  if (e) e.preventDefault();
  if (!bankImport || !bankImport.pending) return;
  const v = id => parseInt(biEl(id).value, 10);
  const map = { hasHeader: biEl('bi-map-header').checked, headerRow: 0, date: v('bi-map-date'), valueDate: -1, amount: v('bi-map-amount'), debit: -1, credit: -1,
    sign: v('bi-map-sign'), name: v('bi-map-name'), iban: -1, account: -1, accountName: -1, entryId: -1, currency: -1, balance: -1,
    desc: v('bi-map-desc') >= 0 ? [v('bi-map-desc')] : [], descLow: [], altName: [] };
  if (map.date === map.amount) return alert('Kies verschillende kolommen voor datum en bedrag.');
  // Kopregel: de gevonden kopregel als die er is, anders de eerste regel.
  if (map.hasHeader) {
    const rows = bankImport.pending.rows;
    let hr = 0; for (let i = 0; i < Math.min(25, rows.length); i++) { if (!MGBank.parseDate(rows[i][map.date])) { hr = i; } else break; }
    map.headerRow = hr;
  }
  const res = MGBank.parseText(bankImport.pending.text, map);
  if (res.error || res.needsMapping || !res.txs || !res.txs.length) {
    return alert('Met deze kolommen konden geen transacties worden gelezen. Controleer de datum- en bedragkolom.');
  }
  res.format = 'CSV'; res.bank = 'eigen kolomindeling';
  const name = bankImport.pending.name;
  bankImport = null; // de bestandsinhoud niet langer bewaren
  biFinishParse([{ name, res }]);
}

// ---------- Voorbeeld ----------
function biSimilar(a, b) {
  const words = s => MGBank.norm(s).replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length >= 3 && !/^\d+$/.test(w) && !['bv', 'nv', 'the', 'van', 'der', 'den', 'het', 'met'].includes(w));
  const A = words(a), B = words(b);
  if (!A.length || !B.length) return false;
  const na = A.join(' '), nb = B.join(' ');
  if (na.includes(nb) || nb.includes(na)) return true;
  const shared = A.filter(w => B.includes(w)).length;
  return shared >= 1 && shared / Math.min(A.length, B.length) >= 0.5;
}
function biDayDiff(a, b) { return Math.round(Math.abs(ymdToDate(a) - ymdToDate(b)) / 86400000); }
function biCategoryExists(type, name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  return (state.categories[type] || []).find(c => c.toLowerCase() === n) || null;
}
function biDefaultCategory(type) {
  return biCategoryExists(type, 'Overig') || (state.categories[type] || [])[0] || 'Overig';
}
function biFirstPeriodStart() {
  const starts = (state.history || []).map(h => h.start).filter(Boolean);
  if (state.lastPeriodStart) starts.push(state.lastPeriodStart);
  return starts.sort()[0] || null;
}

function biBuildPreview(rawTxs, meta) {
  const firstStart = biFirstPeriodStart();
  const curStart = state.lastPeriodStart;
  const todayYmd = toYmd(new Date());
  // Geheugen: welke categorie / welk potje koos je eerder voor deze tegenpartij? (nieuwste eerst)
  const memCat = {}, memPot = {}, memDesc = {};
  [...state.transactions].sort((a, b) => String(b.date).localeCompare(String(a.date))).forEach(t => {
    const k = t.type + '|' + (t.cpKey || '');
    if (t.cpKey && !(k in memCat)) memCat[k] = t.category;
    if (t.cpKey && t.potId && !(k in memPot)) memPot[k] = t.potId;
    const dk = t.type + '|' + MGBank.counterpartyKey(t.description || '', '');
    if (!t.cpKey && t.description && !(dk in memDesc)) memDesc[dk] = t.category;
  });
  const existingKeys = new Set(state.transactions.map(t => t.importKey).filter(Boolean));
  const existingBankKeys = new Set(state.transactions.map(t => t.bankKey).filter(Boolean));
  const seenBankKeys = new Set();
  const existing = state.transactions.map(t => ({ t, ymd: txYmd(t), used: false }));
  const period = recurringPeriod();
  const claimedRec = new Set();
  const seenKeys = new Set();
  let fileDups = 0;
  const rows = [];
  // Oud → nieuw verwerken, zodat 'dubbel' en vaste lasten voorspelbaar worden toegewezen.
  [...rawTxs].sort((a, b) => a.date.localeCompare(b.date)).forEach(r => {
    if (seenKeys.has(r.importKey) || (r.bankKey && seenBankKeys.has(r.bankKey))) { fileDups++; return; }
    seenKeys.add(r.importKey);
    if (r.bankKey) seenBankKeys.add(r.bankKey);
    const type = r.amount < 0 ? 'expense' : 'income';
    const amount = Math.round(Math.abs(r.amount) * 100) / 100;
    const row = { i: rows.length, sel: true, date: r.date, amount, type, description: r.description, note: r.note, key: r.key, importKey: r.importKey, bankKey: r.bankKey || '', file: r.file || '',
      category: null, catSource: '', potId: null, flags: [], dup: null, recurringId: null, recName: '', manualCat: false };
    // 1. Dubbel?
    if (existingKeys.has(r.importKey) || (r.bankKey && existingBankKeys.has(r.bankKey))) row.dup = 'Al eerder geïmporteerd';
    else {
      const cands = existing.filter(x => !x.used && x.t.type === type && Math.abs(x.t.amount - amount) < 0.005);
      let hit = null;
      for (const x of cands) {
        const d = biDayDiff(x.ymd, r.date);
        const sim = biSimilar(x.t.description, r.description) || (r.note && biSimilar(x.t.description, r.note));
        if (x.t.importKey && x.t.importKey === r.importKey) { hit = [x, 'Al eerder geïmporteerd']; break; }
        if (x.t.recurringId && d <= 5) {
          const rec = (state.recurring || []).find(rr => rr.id === x.t.recurringId);
          hit = [x, `Al geboekt als vaste last${rec ? ' “' + rec.name + '”' : ''}`]; break;
        }
        if (d === 0 && sim) { hit = [x, 'Staat al in de app (zelfde dag, bedrag en omschrijving)']; break; }
        if (d <= 3 && sim && !hit) hit = [x, 'Lijkt al in de app te staan'];
      }
      // Zelfde boeking in een ander gekozen bestand (bijv. CSV én PDF tegelijk)?
      if (!hit) {
        const other = rows.find(o => o.file !== row.file && o.type === type && Math.abs(o.amount - amount) < 0.005 && biDayDiff(o.date, r.date) <= 1 && (biSimilar(o.description, r.description) || (r.note && biSimilar(o.description, r.note))));
        if (other) { row.dup = `Staat ook in ${other.file || 'een ander bestand'}`; }
      }
      if (hit) { hit[0].used = true; row.dup = hit[1] + ` (${formatShortDate(hit[0].ymd)}: ${hit[0].t.description || hit[0].t.category})`; }
      else if (!row.dup) {
        const sameDay = cands.find(x => x.ymd === r.date);
        if (sameDay) row.flags.push(`Zelfde bedrag op deze dag staat al in de app (“${sameDay.t.description || sameDay.t.category}”) – controleer even`);
      }
    }
    if (row.dup) row.sel = false;
    // 2. Buiten de periodes van de app?
    if (firstStart && r.date < firstStart) { row.flags.push('Vóór je eerste periode in de app: telt alleen mee in je saldo'); row.sel = false; row.before = true; }
    if (r.date > todayYmd) row.flags.push('Datum ligt in de toekomst');
    // 3. Sparen / eigen rekening
    const hay = MGBank.norm([r.description, r.note, r.name, r.text, r.textLow].join(' '));
    if (r.ownTransfer || MGBank.SAVINGS_RE.test(hay)) { row.flags.push('Overboeking met je spaar- of eigen rekening? Gebruik daarvoor liever een spaardoel'); row.sel = false; }
    // 4. Vaste last van deze periode (nog niet geboekt) → koppelen, zodat die niet nog eens automatisch wordt geboekt.
    if (type === 'expense' && !row.dup && curStart && r.date >= curStart && r.date >= period.start && r.date <= period.end) {
      const rec = (state.recurring || []).find(rr => rr.active && !claimedRec.has(rr.id) && Math.abs(rr.amount - amount) < 0.005 &&
        (biSimilar(rr.name, r.description) || biSimilar(rr.name, r.note || '')) && (() => { const due = recurringOccurrence(rr, period); return due && !isRecurringBooked(rr, period, due); })());
      if (rec) { claimedRec.add(rec.id); row.recurringId = rec.id; row.recName = rec.name; }
    }
    // 5. Categorie: vaste last → eerder gekozen voor deze tegenpartij → zelfde omschrijving → trefwoorden → Overig.
    const recObj = row.recurringId ? state.recurring.find(rr => rr.id === row.recurringId) : null;
    const k = type + '|' + r.key;
    const tryCat = (name, src) => { if (row.category) return; const c = biCategoryExists(type, name); if (c) { row.category = c; row.catSource = src; } };
    if (recObj) tryCat(recObj.category, 'vaste last');
    if (r.key) tryCat(memCat[k], 'onthouden');
    tryCat(memDesc[type + '|' + r.key], 'onthouden');
    tryCat(MGBank.matchRule(r, type), 'herkend');
    if (!row.category) { row.category = biDefaultCategory(type); row.catSource = ''; }
    // 6. Potje (alleen uitgaven in de huidige periode; in afgesloten periodes zijn de potjes al afgerekend).
    row.potAllowed = type === 'expense' && !!curStart && r.date >= curStart;
    if (row.potAllowed) {
      const pid = recObj && recObj.potId ? recObj.potId : memPot[k];
      if (pid && state.pots.some(p => p.id === pid)) row.potId = pid;
    }
    rows.push(row);
  });
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.i - b.i);
  rows.forEach((r, idx) => { r.i = idx; });
  bankImport = { rows, meta: Object.assign({ fileDups }, meta) };
  biRenderPreview();
  biStage('preview');
  return bankImport;
}

function biRowHtml(r) {
  const isExp = r.type === 'expense';
  const cats = [...(state.categories[r.type] || [])];
  if (r.category && !cats.includes(r.category)) cats.unshift(r.category);
  const catSel = `<select data-bi-cat="${r.i}" onchange="biSetCategory(${r.i}, this.value)" class="bi-select">${cats.map(c => `<option value="${escapeHtml(c)}" ${c === r.category ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>`;
  const potSel = r.potAllowed && state.pots.length ? `<select data-bi-pot="${r.i}" onchange="biSetPot(${r.i}, this.value)" class="bi-select">
      <option value="">Geen potje</option>${state.pots.map(p => `<option value="${p.id}" ${p.id === r.potId ? 'selected' : ''}>${escapeHtml(p.emoji || '💰')} ${escapeHtml(p.name)}</option>`).join('')}</select>` : '';
  const warn = [];
  if (r.dup) warn.push(`<p class="bi-warn">⚠︎ Dubbel? ${escapeHtml(r.dup)}</p>`);
  r.flags.forEach(f => warn.push(`<p class="bi-warn">⚠︎ ${escapeHtml(f)}</p>`));
  if (r.recurringId) warn.push(`<p class="bi-info">📅 Telt als vaste last “${escapeHtml(r.recName)}” (wordt niet nog eens automatisch geboekt)</p>`);
  return `
  <label class="bi-row bg-slate-50 rounded-2xl ${r.sel ? '' : 'bi-off'}" data-bi-row="${r.i}">
    <input type="checkbox" data-bi="${r.i}" ${r.sel ? 'checked' : ''} onchange="biToggle(${r.i}, this.checked)" class="w-5 h-5 rounded-md accent-indigo-600 shrink-0 bi-check">
    <div class="flex-1 min-w-0">
      <div class="bi-line">
        <p class="font-semibold text-slate-900 truncate text-[15px]">${escapeHtml(r.description)}</p>
        <p class="font-bold tabular-nums shrink-0 ${isExp ? 'text-rose-600' : 'text-emerald-600'}">${isExp ? '−' : '+'}${formatMoney(r.amount)}</p>
      </div>
      <p class="text-xs text-slate-400 truncate">${formatShortDate(r.date, true)} · ${isExp ? 'Uitgave' : 'Inkomst'}${r.note ? ' · ' + escapeHtml(r.note) : ''}</p>
      ${warn.join('')}
      <div class="bi-selects" onclick="event.stopPropagation()">${catSel}${potSel}</div>
      ${r.catSource ? `<p class="bi-src">${r.catSource === 'onthouden' ? '↺ categorie onthouden van eerder' : r.catSource === 'vaste last' ? 'categorie van de vaste last' : '✨ categorie voorgesteld'}</p>` : ''}
    </div>
  </label>`;
}
function biRenderPreview() {
  if (!bankImport) return;
  const { rows, meta } = bankImport;
  const dups = rows.filter(r => r.dup).length;
  const parts = [`${rows.length} ${rows.length === 1 ? 'transactie' : 'transacties'} gevonden`];
  if (dups) parts.push(`${dups} waarschijnlijk dubbel`);
  if (meta.fileDups) parts.push(`${meta.fileDups} dubbel in het bestand`);
  if (meta.foreign) parts.push(`${meta.foreign} in vreemde munt overgeslagen`);
  if (meta.unreadable) parts.push(`${meta.unreadable} onleesbare regels`);
  biEl('bi-summary').textContent = parts.join(' · ');
  // v37: saldo-controle (PDF-afschriften met begin- en eindsaldo) en gegokte tekens.
  const bal = biEl('bi-balance');
  if (bal) {
    const msgs = [], b = meta.balance || [];
    if (b.length) {
      const bad = b.filter(x => !x.ok);
      if (!bad.length) msgs.push(`✓ Saldo-controle klopt: ${formatMoney(b[0].start)} → ${formatMoney(b[b.length - 1].end)}`);
      else msgs.push(`⚠︎ Saldo-controle klopt niet (verschil ${formatMoney(Math.abs(bad[0].diff))}). Misschien is een regel niet goed gelezen; controleer de lijst.`);
    }
    if (meta.guessed) msgs.push(`⚠︎ Bij ${meta.guessed} ${meta.guessed === 1 ? 'regel' : 'regels'} stond niet of het af of bij was; controleer Uitgave/Inkomst.`);
    bal.textContent = msgs.join(' ');
    bal.className = msgs.length ? ('text-xs mt-1 ' + (msgs.some(m => m.startsWith('⚠')) ? 'bi-warn' : 'bi-info')) : 'hidden';
  }
  biEl('bi-format').textContent = `Bestand: ${meta.files.join(', ')} · ${meta.formats.join(', ')}`;
  biEl('bi-list').innerHTML = rows.map(biRowHtml).join('');
  biUpdateCount();
}
function biUpdateCount() {
  if (!bankImport) return;
  const sel = bankImport.rows.filter(r => r.sel);
  const net = Math.round(sel.reduce((s, r) => s + (r.type === 'income' ? r.amount : -r.amount), 0) * 100) / 100;
  const btn = biEl('bi-submit');
  btn.textContent = sel.length ? `Importeren (${sel.length})` : 'Niets geselecteerd';
  btn.disabled = !sel.length;
  btn.classList.toggle('opacity-50', !sel.length);
  biEl('bi-effect').textContent = sel.length ? `Je saldo verandert met ${net >= 0 ? '+' : '−'}${formatMoney(Math.abs(net))}` : '';
}
function biToggle(i, on) {
  const r = bankImport && bankImport.rows[i];
  if (!r) return;
  r.sel = !!on;
  const el = document.querySelector(`[data-bi-row="${i}"]`);
  if (el) el.classList.toggle('bi-off', !r.sel);
  biUpdateCount();
}
function biSelectAll(on) {
  if (!bankImport) return;
  bankImport.rows.forEach(r => { r.sel = !!on; });
  document.querySelectorAll('#bi-list input[data-bi]').forEach(cb => { cb.checked = !!on; });
  document.querySelectorAll('#bi-list [data-bi-row]').forEach(el => el.classList.toggle('bi-off', !on));
  biUpdateCount();
}
// Andere categorie gekozen: ook voorstellen voor dezelfde tegenpartij in deze import (die je nog niet zelf koos).
function biSetCategory(i, value) {
  const r = bankImport && bankImport.rows[i];
  if (!r) return;
  r.category = value; r.manualCat = true; r.catSource = '';
  bankImport.rows.forEach(o => {
    if (o === r || o.manualCat || !r.key || o.key !== r.key || o.type !== r.type) return;
    o.category = value; o.catSource = 'onthouden';
    const s = document.querySelector(`[data-bi-cat="${o.i}"]`);
    if (s) s.value = value;
  });
}
function biSetPot(i, value) {
  const r = bankImport && bankImport.rows[i];
  if (r) r.potId = value || null;
}

// Werk de samenvatting van afgesloten periodes bij (Geschiedenis), zodat die klopt met de geïmporteerde transacties.
function biRefreshHistory(dates) {
  (state.history || []).forEach(h => {
    if (!dates.some(d => d >= h.start && d <= h.end)) return;
    const snap = makePeriodSnapshot(h.start, h.end, null);
    h.income = snap.income; h.expense = snap.expense; h.net = snap.net; h.categories = snap.categories; h.count = snap.count;
    if (Array.isArray(h.pots)) h.pots.forEach(p => { const s = snap.pots.find(x => x.id === p.id); if (s) p.spent = s.spent; });
  });
}

function biConfirm(e) {
  if (e) e.preventDefault();
  if (!bankImport || !bankImport.rows) return;
  const sel = bankImport.rows.filter(r => r.sel);
  if (!sel.length) return;
  const before = JSON.stringify(state);
  const batch = 'imp-' + uid();
  const now = new Date().toISOString();
  const period = recurringPeriod();
  const r2 = x => Math.round(x * 100) / 100;
  const added = [];
  sel.forEach(r => {
    const [y, m, d] = r.date.split('-').map(Number);
    const curPeriod = !!state.lastPeriodStart && r.date >= state.lastPeriodStart;
    const potId = r.type === 'expense' && curPeriod && r.potId && state.pots.some(p => p.id === r.potId) ? r.potId : null;
    if (potId) { const pot = state.pots.find(p => p.id === potId); pot.balance = r2(pot.balance - r.amount); }
    const tx = { id: uid(), type: r.type, amount: r.amount, description: r.description, category: r.category || biDefaultCategory(r.type), potId,
      date: new Date(y, m - 1, d, 12, 0, 0).toISOString(), source: 'import', importKey: r.importKey, cpKey: r.key || '', importedAt: now, importBatch: batch };
    if (r.note) tx.bankNote = r.note;
    if (r.bankKey) tx.bankKey = r.bankKey;
    if (r.recurringId && curPeriod) {
      const rec = state.recurring.find(x => x.id === r.recurringId);
      const due = rec ? recurringOccurrence(rec, period) : null;
      if (rec && due && !isRecurringBooked(rec, period, due)) { tx.recurringId = rec.id; markRecurringHandled(rec, period, due); }
    }
    state.transactions.push(tx);
    added.push(tx);
  });
  state.transactions.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  biRefreshHistory(added.map(t => txYmd(t)));
  saveState();
  render();
  const skipped = bankImport.rows.length - sel.length + (bankImport.meta.fileDups || 0);
  const cur = added.filter(t => state.lastPeriodStart && txYmd(t) >= state.lastPeriodStart).length;
  const firstStart = biFirstPeriodStart();
  const older = added.filter(t => firstStart && txYmd(t) < firstStart).length;
  bankImport = { done: { count: added.length, skipped, batch, before, after: JSON.stringify(state) } };
  biEl('bi-done-title').textContent = `${added.length} ${added.length === 1 ? 'transactie' : 'transacties'} geïmporteerd`;
  const lines = [`${skipped} overgeslagen`];
  if (cur) lines.push(`${cur} in de huidige periode`);
  if (added.length - cur - older > 0) lines.push(`${added.length - cur - older} in eerdere periodes (ook bijgewerkt in Geschiedenis en Analyse)`);
  if (older) lines.push(`${older} vóór je eerste periode (alleen in je saldo)`);
  biEl('bi-done-text').textContent = lines.join(' · ');
  biStage('done');
  if (typeof haptic === 'function') haptic([10, 40, 10]);
  return { imported: added.length, skipped };
}
function biUndo() {
  const d = bankImport && bankImport.done;
  if (!d) return;
  if (JSON.stringify(state) !== d.after) { alert('Er is intussen iets anders gewijzigd. Verwijder de transacties eventueel los.'); return; }
  if (!confirm(`De import van ${d.count} ${d.count === 1 ? 'transactie' : 'transacties'} ongedaan maken?`)) return;
  state = JSON.parse(d.before);
  saveState();
  render();
  bankImport = null;
  closeModal();
  showToast('Import ongedaan gemaakt');
}
function biClose() { bankImport = null; closeModal(); }
