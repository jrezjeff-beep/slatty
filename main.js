import { Actor } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteer from 'puppeteer';

await Actor.init();

const keywords = [
    'dog supplement',
    'calming chews',
    'dog anxiety',
    'freeze dried dog food',
    'pet wellness',
    'dog probiotics',
    'senior dog care',
    'skin coat dog'
];

// ─── HELPERS ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractDomain(url) {
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return null;
    }
}

function parseFollowers(text) {
    if (!text) return '';
    const match = text.match(/([\d,.]+)\s*([Kk])?\s*(followers|likes|fans|subscribers)/i);
    if (!match) return '';
    let num = parseFloat(match[1].replace(/,/g, ''));
    if (match[2] && /k/i.test(match[2])) num *= 1000;
    return Math.round(num).toString();
}

const SKIP_DOMAINS = [
    'amazon', 'chewy', 'walmart', 'petco', 'petsmart',
    'reddit', 'youtube', 'google', 'facebook', 'instagram',
    'twitter', 'tiktok', 'pinterest', 'yelp', 'wikipedia',
    'shopify', 'myshopify'
];

function isValidDomain(domain) {
    if (!domain) return false;
    return !SKIP_DOMAINS.some(s => domain.includes(s));
}

// ─── BUILD REQUEST LIST ──────────────────────────────────────────────────────

const startUrls = [];

for (const kw of keywords) {
    const encoded = encodeURIComponent(kw);

    // Google search — find DTC pet brand websites
    startUrls.push({
        url: `https://www.google.com/search?q=${encoded}+DTC+pet+brand&num=20`,
        userData: { label: 'GOOGLE', keyword: kw }
    });

    // Google search — Shopify angle
    startUrls.push({
        url: `https://www.google.com/search?q=${encoded}+brand+buy+online+dog&num=20`,
        userData: { label: 'GOOGLE', keyword: kw }
    });

    // my-ip.ms Facebook directory
    startUrls.push({
        url: `https://my-ip.ms/info/social-facebook/search/?q=${encoded.replace(/%20/g, '+')}`,
        userData: { label: 'MYIPMS', keyword: kw }
    });

    // Meta Ad Library (best effort — may be blocked)
    startUrls.push({
        url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encoded}&search_type=keyword_unordered`,
        userData: { label: 'META', keyword: kw }
    });
}

// ─── CRAWLER ────────────────────────────────────────────────────────────────

const puppeteerWithStealth = addExtra(puppeteer);
puppeteerWithStealth.use(StealthPlugin());

const crawler = new PuppeteerCrawler({
    launchContext: {
        launcher: puppeteerWithStealth,
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage'
            ]
        }
    },
    maxRequestsPerCrawl: 300,
    requestHandlerTimeoutSecs: 90,
    maxConcurrency: 3,

    async requestHandler({ request, page, log, pushData }) {
        const { label, keyword } = request.userData;
        log.info(`[${label}] keyword: "${keyword}" — ${request.url}`);

        // Random human-like delay
        await sleep(2000 + Math.random() * 2000);

        // ── GOOGLE ───────────────────────────────────────────────────────────
        if (label === 'GOOGLE') {
            // Wait for results to load
            await page.waitForSelector('body', { timeout: 15000 });
            await sleep(1500);

            const hits = await page.evaluate(() => {
                const items = [];

                // Primary result selector
                const results = document.querySelectorAll('div.g, div[jscontroller], .tF2Cxc');
                results.forEach(el => {
                    const titleEl = el.querySelector('h3');
                    const linkEl = el.querySelector('a[href^="http"]');
                    const snippetEl = el.querySelector(
                        '.VwiC3b, .s3v9rd, span[data-ved], .IsZvec, div[style*="-webkit-line-clamp"]'
                    );

                    if (titleEl && linkEl && linkEl.href && !linkEl.href.includes('google.com')) {
                        items.push({
                            title: titleEl.innerText.trim(),
                            url: linkEl.href,
                            snippet: snippetEl?.innerText?.trim() ?? ''
                        });
                    }
                });

                return items.slice(0, 20);
            });

            log.info(`[GOOGLE] "${keyword}" — found ${hits.length} results`);

            for (const hit of hits) {
                const domain = extractDomain(hit.url);
                if (!isValidDomain(domain)) continue;

                const followers = parseFollowers(hit.snippet);
                const brandName = hit.title
                    .replace(/\s*[-–|·•]\s*.*/g, '')
                    .replace(/\s+(shop|store|official|home|website)$/gi, '')
                    .trim();

                if (brandName.length < 2) continue;

                await pushData({
                    brand_name: brandName,
                    url: `https://${domain}`,
                    estimated_followers: followers,
                    source: 'Google Search',
                    keyword
                });
            }
        }

        // ── MY-IP.MS ─────────────────────────────────────────────────────────
        if (label === 'MYIPMS') {
            await page.waitForSelector('body', { timeout: 15000 });
            await sleep(1000);

            const rows = await page.evaluate(() => {
                const items = [];
                document.querySelectorAll('table tbody tr').forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 2) return;

                    const name = cells[0]?.innerText?.trim();
                    const linkEl = cells[0]?.querySelector('a') ?? cells[1]?.querySelector('a');
                    const url = linkEl?.href ?? '';
                    const fans = cells[cells.length - 1]?.innerText?.trim() ?? '';

                    if (name && name.length > 1) {
                        items.push({ name, url, fans });
                    }
                });
                return items;
            });

            log.info(`[MYIPMS] "${keyword}" — found ${rows.length} rows`);

            for (const row of rows) {
                const domain = row.url ? extractDomain(row.url) : null;
                const cleanUrl = domain ? `https://${domain}` : '';
                const cleanFans = row.fans.replace(/[^\d]/g, '');

                if (!row.name || row.name.length < 2) continue;

                await pushData({
                    brand_name: row.name,
                    url: cleanUrl,
                    estimated_followers: cleanFans,
                    source: 'my-ip.ms',
                    keyword
                });
            }
        }

        // ── META AD LIBRARY ──────────────────────────────────────────────────
        if (label === 'META') {
            // Wait longer — Meta is very JS-heavy
            await sleep(5000);

            try {
                await page.waitForSelector('[data-testid], ._7jyg, .x1yztbdb', { timeout: 20000 });
            } catch {
                log.warning('[META] Page did not load expected selectors — may be blocked');
                return;
            }

            const brands = await page.evaluate(() => {
                const items = [];

                // Try multiple selector patterns Meta uses
                const selectors = [
                    '[data-testid="ad_library_preview_card"]',
                    '._7jyg',
                    '.x1yztbdb',
                    'div[role="article"]'
                ];

                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach(card => {
                        const nameEl = card.querySelector('strong, h2, h3, [role="heading"], span.x193iq5w');
                        const linkEl = card.querySelector('a[href*="facebook.com"]');
                        const name = nameEl?.innerText?.trim();
                        if (name && name.length > 1) {
                            items.push({
                                name,
                                url: linkEl?.href ?? ''
                            });
                        }
                    });
                    if (items.length > 0) break;
                }

                return items;
            });

            log.info(`[META] "${keyword}" — found ${brands.length} brands`);

            for (const brand of brands) {
                if (!brand.name || brand.name.length < 2) continue;
                await pushData({
                    brand_name: brand.name,
                    url: brand.url || '',
                    estimated_followers: '',
                    source: 'Meta Ad Library',
                    keyword
                });
            }
        }
    },

    failedRequestHandler({ request, log }) {
        log.warning(`FAILED: ${request.url}`);
    }
});

await crawler.run(startUrls);

console.log('✅ Scrape complete. Export dataset as CSV from Apify storage.');

await Actor.exit();
