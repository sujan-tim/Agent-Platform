/**
 * An in-memory stand-in for a Google Sheet, with the company's 21 columns and
 * a few fake companies, including a duplicate pair and empty cells.
 */

import type { SheetBackend } from '../src/google.ts';

export const HEADERS = [
  'Company Name',
  'Country',
  'Website',
  'Products',
  'Segment · Application · Product Type',
  'Status',
  'Channel',
  'Channel Org',
  'Source',
  'Volume (MT)',
  'Net Sales',
  'Sales Rep',
  'Current Retailers',
  'Potential Retailers',
  'Reach',
  'Total Output',
  'Company Size',
  'Annual Revenue',
  'Market Presence',
  'Commercial Fit',
  'Outreach Readiness',
];

const row = (values: Partial<Record<string, string>>) => HEADERS.map((h) => values[h] ?? '');

export function practiceRows(): string[][] {
  return [
    HEADERS,
    row({ 'Company Name': 'Sabor Foods S.A.', Country: 'Brazil', Website: 'https://saborfoods.com.br', Status: 'Prospect', Channel: 'Direct', 'Volume (MT)': '1,200', 'Net Sales': '$450,000', 'Sales Rep': 'Maria' }),
    row({ 'Company Name': 'Acme Bakery Inc.', Country: 'USA', Website: 'acmebakery.com', Status: 'Customer', Channel: 'Distributor', 'Volume (MT)': '800', 'Net Sales': '$310,000', 'Sales Rep': 'John' }),
    row({ 'Company Name': 'ACME Bakery', Country: 'USA', Status: 'Prospect', Channel: 'Direct', 'Volume (MT)': '0', 'Net Sales': '0', 'Sales Rep': 'John' }),
    row({ 'Company Name': 'Dulce Vida', Country: 'Mexico', Website: 'www.dulcevida.mx', Status: 'Contacted', Channel: 'Direct', 'Volume (MT)': '450', 'Net Sales': '$120,000', 'Sales Rep': 'Maria' }),
    row({ 'Company Name': 'Nordic Oats AB', Country: 'Sweden', Status: 'Prospect', Channel: 'Distributor', 'Volume (MT)': '300', 'Net Sales': '$95,000', 'Sales Rep': 'Ana' }),
    row({ 'Company Name': 'Green Snacks Ltd', Country: 'UK', Website: 'greensnacks.co.uk', Status: 'Customer', Channel: 'Direct', 'Volume (MT)': '2,100', 'Net Sales': '$780,000', 'Sales Rep': 'Ana' }),
    row({ 'Company Name': 'Pan Rico', Country: 'Mexico', Status: 'Prospect', Channel: 'Distributor', 'Volume (MT)': '150', 'Net Sales': '$40,000', 'Sales Rep': 'Maria' }),
    [],
    row({ 'Company Name': 'Bright Dairy Co', Country: 'USA', Website: 'https://www.acmebakery.com/dairy', Status: 'Lost', Channel: 'Direct', 'Volume (MT)': '75', 'Net Sales': '$20,000', 'Sales Rep': 'John' }),
  ];
}

export class FakeSheet implements SheetBackend {
  grid: string[][];
  reads = 0;

  constructor(
    rows = practiceRows(),
    readonly tabNames = ['Companies', 'Notes'],
  ) {
    this.grid = rows.map((r) => [...r]);
  }

  async tabs(): Promise<string[]> {
    return this.tabNames;
  }

  async read(tab: string): Promise<string[][]> {
    this.reads++;
    if (tab === 'Notes') return [['Notes'], ['nothing here']];
    // Like the Sheets API: trailing empty cells are left off each row.
    return this.grid.map((r) => {
      const copy = [...r];
      while (copy.length && !copy.at(-1)) copy.pop();
      return copy;
    });
  }

  async write(_tab: string, cells: Array<{ row: number; column: number; value: string }>): Promise<void> {
    for (const c of cells) {
      while (this.grid.length < c.row) this.grid.push([]);
      const r = this.grid[c.row - 1];
      while (r.length < c.column) r.push('');
      r[c.column - 1] = c.value;
    }
  }

  async append(_tab: string, values: string[]): Promise<void> {
    this.grid.push([...values]);
  }
}
