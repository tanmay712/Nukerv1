# Vaultly wallet demo

A simulated crypto wallet interface displaying a $78.00 USDT balance on Polygon. Withdrawals are simulated locally with a selectable paid or failed outcome after one minute. Paid withdrawals reduce the simulated balance; failed withdrawals leave it unchanged. Paid withdrawals receive a simulated ID and a link to a local transaction detail page. These records are only available in the same browser. State is stored in browser local storage, and no blockchain connection or real funds are involved.

## Run

Requires Node.js. From the repository root, run:

```sh
npm start
```

Open `http://localhost:6546`. The server listens on port 6546.
