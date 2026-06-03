---
title: Amazon product extraction
tags:
  - amazon
  - ecommerce
  - extraction
createdAt: 1780444800
---

# Amazon Product Extraction

Use a real logged-in browser session when possible. Amazon is much more
likely to show CAPTCHA or incomplete content to a fresh anonymous profile.

## Direct Product Page

Open product pages in a fresh tab first:

```json
{"name":"new_tab","arguments":{"url":"https://www.amazon.com/dp/B08Z6X4NK3"}}
```

Then wait:

```json
{"name":"wait_for_load","arguments":{"timeoutSeconds":15}}
{"name":"wait","arguments":{"seconds":2}}
```

Extract title, price, rating, review count, availability, brand, ASIN,
and bullet points with `js`:

```js
({
  title: document.querySelector('#productTitle')?.innerText?.trim() || null,
  price: (() => {
    const whole = document.querySelector('.a-price-whole')?.innerText?.replace(/[\n.]/g, '');
    const frac = document.querySelector('.a-price-fraction')?.innerText;
    return whole && frac
      ? `$${whole}.${frac}`
      : document.querySelector('.a-price .a-offscreen')?.innerText || null;
  })(),
  list_price: document.querySelector('.basisPrice .a-offscreen')?.innerText || null,
  rating: document.querySelector('#acrPopover')?.getAttribute('title') || null,
  review_count: document.querySelector('#acrCustomerReviewText')?.innerText || null,
  availability: document.querySelector('#availability span')?.innerText?.trim() || null,
  brand: document.querySelector('#bylineInfo')?.innerText?.trim() || null,
  asin: document.querySelector('input[name="ASIN"]')?.value || null,
  bullet_points: Array.from(document.querySelectorAll('#feature-bullets li span.a-list-item'))
    .map((e) => e.innerText?.trim())
    .filter(Boolean),
})
```

## Search Results

Use direct search URLs instead of typing unless the user needs a visible
search workflow:

```json
{"name":"new_tab","arguments":{"url":"https://www.amazon.com/s?k=mechanical+keyboard"}}
{"name":"wait_for_load","arguments":{"timeoutSeconds":15}}
{"name":"wait","arguments":{"seconds":2}}
```

Extract cards:

```js
Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'))
  .map((el) => ({
    asin: el.getAttribute('data-asin') || null,
    title: el.querySelector('h2 span')?.innerText?.trim() || null,
    price: el.querySelector('.a-price .a-offscreen')?.innerText || null,
    list_price: el.querySelector('.a-text-price .a-offscreen')?.innerText || null,
    rating: el.querySelector('[aria-label*="out of 5 stars"]')
      ?.getAttribute('aria-label')
      ?.split(' ')[0] || null,
    reviews: el.querySelector('[aria-label*="ratings"]')?.getAttribute('aria-label') || null,
    is_sponsored: !!el.querySelector('.puis-sponsored-label-text'),
    url: el.querySelector('h2 a')?.href || null,
  }))
  .filter((r) => r.asin)
```

## CAPTCHA Check

Stop and tell the user if Amazon shows CAPTCHA. Do not try to bypass it.

```js
(() => {
  const text = document.body.innerText.slice(0, 800).toLowerCase();
  const url = location.href.toLowerCase();
  return (
    text.includes('captcha') ||
    text.includes('enter the characters') ||
    text.includes('sorry, we just need to make sure') ||
    url.includes('captcha') ||
    url.includes('validatecaptcha')
  );
})()
```

## Notes

- Prefer `new_tab()` for the first Amazon navigation in a session.
- `#priceblock_ourprice` and `#priceblock_dealprice` are legacy and often null.
- Sponsored search results commonly appear first; filter with `!is_sponsored`
  when the user asks for organic results.
- Amazon loads result cards after `document.readyState === "complete"`;
  keep the 2 second wait unless you replace it with a stronger DOM wait.
