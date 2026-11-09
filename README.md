# POS with MongoDB Atlas

1. In Atlas: create a free cluster, a database user, and allow your IP (Network Access).
2. `cp .env.example .env` and fill in `MONGODB_URI` and a long random `JWT_SECRET`.
3. `npm install` then `npm start`, and open http://localhost:3000
4. Register your company (this creates the admin), then add cashiers/managers from Settings > Users.

Deploy to Render/Railway/Fly: set the same env vars there and use `npm start`.
Data is loaded at login and refreshed every 30 seconds so several devices stay roughly in sync.

## Deploy on Netlify
Push to GitHub, then Netlify > Add new site > Import from Git. `netlify.toml` sets everything up.
Add `MONGODB_URI` and `JWT_SECRET` under Site configuration > Environment variables, then deploy.
In Atlas > Network Access allow `0.0.0.0/0`.

## Backup on Render (same code, same database)
Both Netlify and Render run this project and talk to the same Atlas database, so data is identical on both.
If Netlify is paused or out of credits, just open the Render address instead.

1. Push this project (with `render.yaml`) to GitHub.
2. Render > New > Blueprint > pick the repository (or New > Web Service with build `npm install`, start `npm start`).
3. When asked, enter `MONGODB_URI` (same as Netlify) and `JWT_SECRET` (any long random string).
4. Deploy, then open `https://<name>.onrender.com/api/health`. You want `{"server":"ok","database":"connected"}`.

Notes
- Render's free plan sleeps after 15 minutes idle; the first visit afterwards can take about 30 seconds.
- Log in again on the Render address (browsers keep logins separately per website address).
- Atlas > Network Access must allow `0.0.0.0/0`.

## New in this version
- **Returns & refunds** (Reports > Refund), **expenses**, **stock history & adjustments**, **low stock list**, **audit log**.
- **Export to CSV, full backup and restore** (Settings > Backup & export, admin only).
- **Hold a sale** (Cart > Hold / Held).
- **Works offline**: install the site to the home screen. Sales, stock and other records made without internet are saved on the device and sent automatically when the connection returns.
- **Password reset**: users change their own password; admins reset anyone's; a forgotten password is reset with the **recovery code** shown once at registration (admins can make a new one in Settings).

Redeploy BOTH `server.js` and `public/` (index.html, sw.js, manifest.webmanifest, icon.svg).
Existing companies have no recovery code yet: log in as admin, open Settings and tap **Recovery code**.

## Stock report and monthly graph
- **Settings > Stock report** (admin, manager): stock cost, retail value and potential profit per category and per product, with an overall total. Untick **Count in total** to leave a category out of the overall total (saved on that device). Export to CSV.
- **Reports > Monthly sales graph**: sales and profit for each month of a year, with year arrows and a monthly table.

## Branches
- Each company can have several branches. Every branch has its own categories, products, stock, sales, expenses and receipts numbering.
- **Settings > Branches** (admin): add, rename or delete branches, **Copy products** between branches (stock starts at 0) and **Transfer stock** from the current branch to another.
- **Settings > Users**: choose which branches each manager or cashier can use. They only ever receive data for their own branches. Admins see everything.
- People with more than one branch can switch in **Settings > Branch**. Admins also get **All branches (reports)** for combined Reports, Stock report, Expenses, history and audit log. Selling and stock changes need a single branch.
- Existing companies get one branch called **Main** automatically the first time someone opens the app after this update, and all current data belongs to it.
- Deploy BOTH `server.js` and `public/`.

## Currency and number format
- Amounts use thousands separators (1,234,567.50) and quantities too (1,250).
- **Settings > Currency** (admin) sets the company currency symbol: $, £, €, KSh, TSh, USh, ₦, GH₵, R, ₹ or your own. It applies to every screen and receipt, for all users. Existing amounts are not converted. Redeploy `server.js` as well as `public/`.

## Import, renaming and custom columns
- **Settings > Products & categories > Import**: upload a CSV or Excel file (Excel needs internet the first time to load the reader; CSV works offline). Map the file's columns to Category, Product, Barcode, Buying price, Selling price, Stock and any custom columns, choose how stock should be handled for products that already exist, check the preview and import. A template can be downloaded.
- **Edit** buttons on categories and products let you rename them (and change price, barcode, category and extra fields). Past receipts keep the names they were sold under.
- **Custom columns** (admin and manager): add extra fields such as Brand or Expiry date to categories or products. They appear in the add/edit forms, tables, imports and CSV exports, and in backups. Redeploy `server.js` too, since the column list is stored on the company.

## Reports mini-tabs, trends, price history
- **Reports** is split into mini-tabs: Overview (today/week + weekly graph), Sales (transactions), Profit (summary + daily profit), Payments (methods + refunds), Monthly (monthly graph), and **Top sellers & trends**. The period card has quick ranges (Today, 7 days, 30 days, This month, This year, All time) plus From/To dates.
- **Top sellers & trends**: revenue/sales/profit against the previous period, top 10 products, top sellers table, categories, busiest hours and days, slow movers, and cashier performance.
- **Settings > Price history** (admin, manager): every buying/selling price change with old and new price, % change and who made it. Also reachable with **Prices** next to each product.
- The checkout discount option was removed. Receipts and reports still show discounts on older sales.
- Tables: choose how many rows to show (5, 10, 25, 50, 100 or All); the choice is remembered, and each table shows its range (for example 11-20 of 57).
- Only `public/index.html` changed in this version.

## Faster loading for big shops
- The app now loads only the last 35 days of sales when it opens. Older sales load the first time a report needs them (for example "All time", or a date range further back) and stay loaded for that session.
- Every 30 seconds each device sends one tiny request to ask "has anything changed?" and then downloads only what changed: new sales, stock changes or the product list. Before, it downloaded everything every time.
- Monthly totals are worked out by the database, so a whole year of sales is never downloaded for the Monthly tab.
- The Sales tab shows the newest 2,000 transactions of the chosen period (use a narrower period or Export CSV for the rest).
- Redeploy BOTH `server.js` and `public/index.html`.

## Receipt design
- **Settings > Receipt design** (admin): logo (resized automatically), extra header lines, footer message, paper (58 mm, 80 mm, A4), text size, font, and what to show (motto, branch, cashier, customer, payment). A live preview updates as you type.
- The design is saved on the company and used on every device. When printing, choose the same paper size in the printer dialog.

## Your logo
- `public/logo.png` (login screen), `public/icon-192.png` and `icon-512.png` (app icon, favicon, home-screen icon) and `public/receipt-logo.jpg` (receipts) come from the Kamau Electronics logo. Replace these files with other images of the same names to rebrand.
- Receipts print `receipt-logo.jpg` by default. In **Settings > Receipt design** you can remove it, upload another logo, or tap **Use built-in logo** to bring it back. A good extra header line is: `TVs · Woofers · M-KOPA Payment · Phone Repair`.

## Serial numbers, customer accounts, layaway, aged stock
- **Remove an item**: every cart line has a ✕ button (all roles).
- **Serial numbers / IMEI**: tick *Track serial numbers* when adding a product and paste its serials (one per line). Adding stock to such a product takes a list of serials. At checkout you pick the unit (or scan or type its IMEI); the serial prints on the receipt and shows in stock history. Refunds and deleted receipts return the serial to stock. **Settings > Serial / IMEI lookup** finds a unit in stock or the receipt, customer and date it was sold on.
- **Customers and credit sales**: **Settings > Customers** keeps accounts with phone, notes and a credit limit (set by admin/manager). In the cart pick a customer account, then choose the payment method **Credit** (alone or split with cash). Balances, payments received, statements (printable) and refunds "to account" are tracked per customer. Cashiers cannot go over a customer's limit.
- **Deposit and layaway**: in the cart tap **Layaway**, enter the customer, deposit and optional collect-by date. The items are set aside (stock and serials reserved) and a deposit receipt prints. **Settings > Layaway** lists open layaways: add payments, print receipts, **Complete** once paid in full (this becomes the sale, with the original payments) or **Cancel** (admin/manager) with a refund and return to stock.
- **Aged stock** (admin, manager): **Settings > Aged stock** lists products unsold for 30/60/90/180+ days with the money tied up in them, and exports to CSV.
- Redeploy BOTH `server.js` and `public/`. Backups now include customers, layaways and the credit ledger.

## Global search, recovery code, search clearing
- **Search everything**: the 🔍 button at the top right (next to settings) searches products (names, barcodes, serial numbers/IMEIs, custom columns), customers (name, phone), receipts (number, customer, item, serial) and layaways from one box. Add a product to the cart, open a receipt or a customer statement straight from the results. **Search older sales** looks beyond the loaded period.
- **Recovery code for the admin**: **Settings > Recovery code** asks for the admin password and then shows the code again (with Copy and *Generate a new code*). The code is stored encrypted on the server with a key made from `JWT_SECRET`, so keep `JWT_SECRET` unchanged. Companies created before this version have no viewable code: generate a new one once. Wrong-password attempts are limited.
- The checkout search box is cleared after a sale, a layaway or a held sale.
- Redeploy BOTH `server.js` and `public/`.

## Subscriptions and the owner console
- Every company has a subscription end date. New companies get a free trial (`SUB_TRIAL_DAYS`, default 14). Companies created before this version have **no end date and are never blocked** until you set one.
- **Active**: everything works. In the last 7 days admins see a reminder banner. **Grace** (the `SUB_GRACE_DAYS` after the end date, default 3): everything works but every user sees a red warning. **Expired or suspended**: the server blocks all data requests and users see a "Subscription expired" screen with your contact (`OWNER_CONTACT`) and a **Check again** button. Work done while blocked is kept on the device and sent after renewal. Logging in always works, so people see why they are blocked. Their data is kept.
- A device that stays offline past the end date plus grace also shows the screen until it can connect and check.
- **Owner console**: set `OWNER_KEY` on the server, then open `https://your-site/owner.html`, enter the key, and extend (+30 / +90 / +1 year or a date), suspend or resume any company, and make a new recovery code if a shop has lost theirs. Nothing links to this page.
- `ALLOW_SIGNUP=false` closes public registration so only you decide which companies exist (you would then create them by briefly setting it to true, or ask for a create-company option in the owner console).
- **Recovery code**: admins can only *view* it (Settings > Recovery code, password required). The option to make a new one was removed; only the owner can do that, from the owner console. Companies that never had a viewable code get one the first time an admin opens that screen.
- Redeploy BOTH `server.js` and `public/`, and add the new settings in Netlify/Render if you want them.

## Transfers, copying products, printing
- **Settings > Transfers**: admins and managers choose a receiving branch, tick **any number of products** (units of serial-number products are chosen one by one; *All shown* ticks everything on screen), add a **side note**, and send. The items leave the sender's stock straight away.
- **The receiving branch decides**: anyone working at that branch (any role) sees a banner and the transfer under Transfers, reads the note and items, and taps **Accept** (goods are added to their stock, categories and products are created if they do not exist, matched by barcode or name) or **Decline** with a reason (goods go back to the sender automatically). The sender can **Cancel** while it is still waiting. Every step is recorded in stock history and a printable **transfer note** (with signature lines) is available for every transfer.
- **Copy products between branches** (admin): **Settings > Products & categories > Copy to branch** or **Branches > Copy products**. Copy **one product**, **a whole category** (tick the category), **chosen products**, or **everything**. Prices, barcodes and custom columns are copied; stock can be copied too (not for serial products). Products the other branch already has are skipped. Each product also has a **Copy** button in its category's *View products* list.
- **Printing**: a 🖨 button at the top right prints the page you are on (every report tab, stock report, aged stock, price history, expenses, stock history, customers, layaways, transfers and more) with a heading, the branch and the date; all rows are printed, and any hidden columns stay hidden. Ready-made documents: **Price list** (Products page), **Stock count sheet** with blank "Counted" column (Stock page), **Daily summary** with cash expected in the till (Reports), transfer notes, receipts, layaway receipts and customer statements.
- Redeploy BOTH `server.js` (and the new `lib/transfer.js`) and `public/`.

## Notes about outdated data
- **Offline**: a red note at the top says "you are seeing data saved on this device (updated 2 h ago)" and how many changes are waiting to sync. It disappears when the device reconnects and refreshes.
- **Not refreshed for 3 minutes while online** (for example a slow connection or a long-open form): "Data may be out of date. It was last updated 6 min ago" with a **Refresh** button. Every successful background check (every 30 seconds) and every refresh resets it; coming back to the app after being away refreshes it too.
- **Newer app version**: when a new version has been deployed, "A newer version of the app is available" with a **Reload** button.
- Printed pages say "data as of ..." in their heading.
- Only `public/index.html` changed in this version.

## Receipt numbers, stock number editing, receipt editing
- **No more duplicate receipt numbers**: when online, the server hands out the next receipt number for the branch at checkout, so two devices can never use the same one. When a device is offline, its receipts are numbered with its own device number (for example **D2-0001**, shown on the receipt and in the lists) and cannot clash with anything; they sync normally when the connection returns. Layaway numbers work the same way. Tapping Checkout twice while a sale is saving is ignored.
- **Fix numbers that already clash** (admin): **Settings > Backup & export > Receipt numbers > Check for duplicate numbers**, then **Give them new numbers**. The oldest receipt keeps its number.
- **Edit the stock number**: **Edit** next to the stock figure in the Stock list, the Low stock list and a category's product list (admin, manager). Type the real count; the difference goes into stock history and the audit log. For serial-number products the same button opens a screen to remove units (damaged, lost…) and add new ones.
- **Edit receipt details** (admin, manager): **Reports > Sales > Edit** changes the customer name, phone and note, and the payment method and transaction code of each payment. Amounts and items cannot be changed there (use refund or delete), and credit payments are locked. The change goes in the audit log and the receipt prints the new details.
- Redeploy BOTH `server.js` and `public/`. `tests/` holds the browser test for this version.
