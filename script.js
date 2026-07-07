// Phase 6: batch-safe lookups — concurrency limit, retry-with-backoff on rate limits, live progress.

const codesInput = document.getElementById('codesInput');
const pasteBtn = document.getElementById('pasteBtn');
const searchBtn = document.getElementById('searchBtn');
const statusArea = document.getElementById('statusArea');
const resultsBody = document.getElementById('resultsBody');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportXlsxBtn = document.getElementById('exportXlsxBtn');

let currentResults = [];

const CONCURRENCY_LIMIT = 5; // how many lookups run at once
const BATCH_DELAY_MS = 250; // pause between batches to ease off rate limits

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    codesInput.value = text.trim();
  } catch (err) {
    showStatus('Could not read clipboard. Paste manually with Ctrl/Cmd+V.', true);
  }
});

searchBtn.addEventListener('click', async () => {
  const codes = getCodes();
  if (codes.length === 0) {
    showStatus('Paste at least one ASIN or ISBN first.', true);
    return;
  }

  const parsed = codes.map(parseCode);
  currentResults = parsed;
  renderResults(parsed);
  toggleExportButtons(parsed.length > 0);

  const lookupCount = parsed.filter((row) => row.status === 'ok').length;
  if (lookupCount === 0) {
    showStatus(`Parsed ${parsed.length} code(s). None were valid ISBNs, so no lookups to run.`, true);
    return;
  }

  searchBtn.disabled = true;

  const lookupRows = parsed
    .map((row, index) => ({ row, index }))
    .filter((item) => item.row.status === 'ok');

  let completed = 0;
  showStatus(`Looking up 0 of ${lookupCount} book(s)...`, false);

  for (let i = 0; i < lookupRows.length; i += CONCURRENCY_LIMIT) {
    const batch = lookupRows.slice(i, i + CONCURRENCY_LIMIT);

    await Promise.all(
      batch.map(async ({ row, index }) => {
        const result = await resolveTitle(row);
        updateRowBookName(
          index,
          result ? result.title : 'Not found (Google Books or Open Library)',
          Boolean(result)
        );
        completed += 1;
        showStatus(`Looking up ${completed} of ${lookupCount} book(s)...`, false);
      })
    );

    const isLastBatch = i + CONCURRENCY_LIMIT >= lookupRows.length;
    if (!isLastBatch) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  searchBtn.disabled = false;
  showStatus(`Done. Looked up ${lookupCount} book(s).`, false);
});

function getCodes() {
  return codesInput.value
    .split(/[\n,;\t]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// --- Core parsing logic ---

function parseCode(raw) {
  const clean = raw.toUpperCase().replace(/[-\s]/g, '');

  if (isValidIsbn13(clean)) {
    const isbn10 = clean.startsWith('978') ? isbn13ToIsbn10(clean) : null;
    return {
      asin: raw,
      isbn10: isbn10 || 'N/A (not convertible)',
      isbn13: clean,
      status: 'ok',
      bookName: 'Looking up...',
    };
  }

  if (isValidIsbn10(clean)) {
    return {
      asin: raw,
      isbn10: clean,
      isbn13: isbn10ToIsbn13(clean),
      status: 'ok',
      bookName: 'Looking up...',
    };
  }

  return {
    asin: raw,
    isbn10: 'N/A',
    isbn13: 'N/A',
    status: 'unrecognized',
    bookName: 'Not a valid ISBN-10/13 — may be an Amazon-only ASIN',
  };
}

function isValidIsbn10(code) {
  if (!/^[0-9]{9}[0-9X]$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (10 - i) * Number(code[i]);
  }
  const last = code[9] === 'X' ? 10 : Number(code[9]);
  sum += last;
  return sum % 11 === 0;
}

function isValidIsbn13(code) {
  if (!/^[0-9]{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

function isbn10ToIsbn13(isbn10) {
  const core = '978' + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

function isbn13ToIsbn10(isbn13) {
  const core = isbn13.slice(3, 12); // 9 digits, drop the "978" prefix and old check digit
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (10 - i) * Number(core[i]);
  }
  const remainder = sum % 11;
  const checkVal = (11 - remainder) % 11;
  const check = checkVal === 10 ? 'X' : String(checkVal);
  return core + check;
}

// --- Rendering ---

function renderResults(rows) {
  resultsBody.innerHTML = '';

  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = String(index);
    if (row.status === 'unrecognized') tr.classList.add('row-error');

    tr.innerHTML = `
      <td class="mono">${escapeHtml(row.asin)}</td>
      <td class="book-name-cell">${escapeHtml(row.bookName)}</td>
      <td class="mono">${escapeHtml(row.isbn10)}</td>
      <td class="mono">${escapeHtml(row.isbn13)}</td>
    `;
    resultsBody.appendChild(tr);
  });
}

function updateRowBookName(index, text, found) {
  if (currentResults[index]) currentResults[index].bookName = text;

  const tr = resultsBody.querySelector(`tr[data-row-index="${index}"]`);
  if (!tr) return;
  const cell = tr.querySelector('.book-name-cell');
  cell.textContent = text;
  if (!found) tr.classList.add('row-error');
}

// --- Book lookups: Google Books first, Open Library as fallback ---

async function resolveTitle(row) {
  const candidates = [row.isbn13, row.isbn10].filter(
    (code) => code && !code.startsWith('N/A')
  );

  for (const isbn of candidates) {
    const title = await fetchFromGoogleBooks(isbn);
    if (title) return { title, source: 'Google Books' };
  }

  for (const isbn of candidates) {
    const title = await fetchFromOpenLibrary(isbn);
    if (title) return { title, source: 'Open Library' };
  }

  return null;
}

async function fetchFromGoogleBooks(isbn, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  try {
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`
    );

    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      await sleep(500 * attempt); // back off a bit longer each retry
      return fetchFromGoogleBooks(isbn, attempt + 1);
    }

    if (!res.ok) return null;
    const data = await res.json();
    const info = data?.items?.[0]?.volumeInfo;
    if (!info?.title) return null;
    return info.subtitle ? `${info.title}: ${info.subtitle}` : info.title;
  } catch (err) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFromOpenLibrary(isbn) {
  try {
    const res = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data[`ISBN:${isbn}`];
    return entry?.title || null;
  } catch (err) {
    return null;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showStatus(message, isError) {
  statusArea.hidden = false;
  statusArea.textContent = message;
  statusArea.classList.toggle('error', Boolean(isError));
}

// --- Export ---

function toggleExportButtons(show) {
  exportCsvBtn.hidden = !show;
  exportXlsxBtn.hidden = !show;
}

exportCsvBtn.addEventListener('click', () => {
  const header = ['ASIN', 'Book Name', 'ISBN-10', 'ISBN-13'];
  const csvRows = [header, ...currentResults.map(rowToArray)];
  const csvContent = csvRows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
  downloadBlob(csvContent, 'asin-isbn-results.csv', 'text/csv;charset=utf-8;');
});

exportXlsxBtn.addEventListener('click', () => {
  const header = ['ASIN', 'Book Name', 'ISBN-10', 'ISBN-13'];
  const data = [header, ...currentResults.map(rowToArray)];
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Results');
  XLSX.writeFile(workbook, 'asin-isbn-results.xlsx');
});

function rowToArray(row) {
  return [row.asin, row.bookName, row.isbn10, row.isbn13];
}

function escapeCsvField(field) {
  const str = String(field ?? '');
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}