// The symbol of the currency the Money pages count in: `currencySymbol` in config.json. The engine
// sets it at boot and the web app when the health answer arrives. Amounts are kept in `ils` fields
// and money.json says "ILS": in both, that means your home currency, whatever its symbol is.

let symbol = '₪';

export function homeCurrencySymbol(): string {
  return symbol;
}

export function setHomeCurrencySymbol(next: string): void {
  symbol = next;
}
