import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ZolaClient } from '../client.js';
import { MobileEnvelope, ToolResult, jsonResult } from '../types.js';

interface BudgetPayment {
  uuid: string;
  budget_item_uuid: string;
  payment_type: string;
  amount_cents: number;
  note: string | null;
  paid_at: number | null;
  due_at: number | null;
  remind_at: number | null;
}

interface BudgetItem {
  uuid: string;
  taxonomy_node_uuid: string;
  title: string;
  cost_cents: number;
  estimate: boolean;
  estimated_cost_cents: number;
  actual_cost_cents: number;
  item_type: string | { key: string; display_name: string };
  paid_cents: number;
  note: string | null;
  payments: BudgetPayment[];
  // The API returns the linked vendor as a nested object, not a flat uuid.
  account_vendor?: { uuid: string; vendor_name: string | null } | null;
}

interface TaxonomyNode {
  title: string;
  items: BudgetItem[];
}

interface Budget {
  uuid: string;
  budgeted_cents: number;
  cost_cents: number;
  actual_cost_cents?: number;
  paid_cents: number;
  balance_due_cents: number;
  taxonomy_nodes: TaxonomyNode[];
}

function itemTypeKey(item_type: string | { key: string }): string {
  return typeof item_type === 'string' ? item_type : item_type.key;
}

export async function getBudget(client: ZolaClient): Promise<ToolResult> {
  const response = await client.requestMobile<MobileEnvelope<Budget>>('GET', '/v3/budgets');
  const budget = response.data;
  const items = budget.taxonomy_nodes.flatMap((node) =>
    node.items.map((item) => ({
      uuid: item.uuid,
      taxonomy_node_uuid: item.taxonomy_node_uuid,
      title: item.title,
      item_type: itemTypeKey(item.item_type),
      cost_cents: item.cost_cents,
      estimated_cost_cents: item.estimated_cost_cents,
      actual_cost_cents: item.actual_cost_cents,
      paid_cents: item.paid_cents,
      note: item.note,
      payment_count: item.payments.length,
      account_vendor_uuid: item.account_vendor?.uuid ?? null,
      account_vendor_name: item.account_vendor?.vendor_name ?? null,
    }))
  );
  const summary = {
    budgeted_cents: budget.budgeted_cents,
    cost_cents: budget.cost_cents,
    paid_cents: budget.paid_cents,
    balance_due_cents: budget.balance_due_cents,
    items,
  };
  return jsonResult(summary);
}

export async function updateBudgetItem(client: ZolaClient, args: {
  uuid: string;
  actual_cost_cents?: number;
  note?: string;
}): Promise<ToolResult> {
  const response = await client.requestMobile<MobileEnvelope<Budget>>('GET', '/v3/budgets');
  const allItems = response.data.taxonomy_nodes.flatMap((node) => node.items);
  const current = allItems.find((item) => item.uuid === args.uuid);
  if (!current) {
    throw new Error(`Budget item with UUID "${args.uuid}" not found`);
  }
  const body = {
    item_uuid: args.uuid,
    taxonomy_node_uuid: current.taxonomy_node_uuid,
    estimated_cost_cents: current.estimated_cost_cents,
    actual_cost_cents: args.actual_cost_cents ?? current.actual_cost_cents,
    note: args.note ?? current.note,
    item_type: itemTypeKey(current.item_type),
    title: current.title,
    // Must be re-sent on every PUT, or the item is unlinked from its booked vendor.
    ...(current.account_vendor?.uuid ? { account_vendor_uuid: current.account_vendor.uuid } : {}),
  };
  const result = await client.requestMobile<MobileEnvelope<BudgetItem>>('PUT', '/v3/budgets/items', body);
  return jsonResult(result.data);
}

type PaymentType = 'PAID' | 'PENDING';

interface BudgetPaymentRecord extends BudgetPayment {
  budget_item_title: string;
}

/**
 * Convert a tool date arg to epoch ms. Date-only strings (YYYY-MM-DD) are pinned
 * to 12:00 UTC so they render as the same calendar day in any US/EU timezone —
 * a bare `new Date('2027-05-15')` is UTC midnight, which shows as the 14th in the US.
 */
function toEpochMs(value: string): number {
  const ms = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value).getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid date "${value}" (expected YYYY-MM-DD or ISO 8601)`);
  return ms;
}

function optionalEpochMs(value: string | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  return toEpochMs(value);
}

function formatPayment(p: BudgetPayment & { budget_item_title?: string }) {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    uuid: p.uuid,
    budget_item_uuid: p.budget_item_uuid,
    ...(p.budget_item_title !== undefined ? { budget_item_title: p.budget_item_title } : {}),
    payment_type: p.payment_type,
    amount_cents: p.amount_cents,
    note: p.note,
    paid_at: iso(p.paid_at),
    due_at: iso(p.due_at),
    remind_at: iso(p.remind_at),
  };
}

export async function listBudgetPayments(client: ZolaClient, args: { item_uuid?: string }): Promise<ToolResult> {
  const response = await client.requestMobile<MobileEnvelope<Budget>>('GET', '/v3/budgets');
  const items = response.data.taxonomy_nodes.flatMap((node) => node.items);
  const selected = args.item_uuid ? items.filter((item) => item.uuid === args.item_uuid) : items;
  if (args.item_uuid && selected.length === 0) {
    throw new Error(`Budget item with UUID "${args.item_uuid}" not found`);
  }
  const payments = selected.flatMap((item) =>
    item.payments.map((p) => formatPayment({ ...p, budget_item_title: item.title }))
  );
  return jsonResult(payments);
}

export async function addBudgetPayment(client: ZolaClient, args: {
  item_uuid: string;
  payment_type: PaymentType;
  amount_cents: number;
  note?: string;
  due_at?: string;
  paid_at?: string;
  remind_at?: string;
}): Promise<ToolResult> {
  const body = {
    item_uuid: args.item_uuid,
    payment_type: args.payment_type,
    amount_cents: args.amount_cents,
    note: args.note ?? null,
    paid_at: optionalEpochMs(args.paid_at) ?? null,
    due_at: optionalEpochMs(args.due_at) ?? null,
    remind_at: optionalEpochMs(args.remind_at) ?? null,
  };
  const result = await client.requestMobile<MobileEnvelope<BudgetPaymentRecord>>('POST', '/v3/budgets/payments', body);
  return jsonResult(formatPayment(result.data));
}

export async function updateBudgetPayment(client: ZolaClient, args: {
  uuid: string;
  payment_type?: PaymentType;
  amount_cents?: number;
  note?: string | null;
  due_at?: string | null;
  paid_at?: string | null;
  remind_at?: string | null;
}): Promise<ToolResult> {
  // PUT replaces the whole payment, so read-modify-write to keep untouched fields.
  const current = (await client.requestMobile<MobileEnvelope<BudgetPaymentRecord>>(
    'GET',
    `/v3/budgets/payments/${args.uuid}`
  )).data;
  const pick = <T>(next: T | undefined, prev: T): T => (next === undefined ? prev : next);
  const body = {
    payment_uuid: args.uuid,
    item_uuid: current.budget_item_uuid,
    payment_type: pick(args.payment_type, current.payment_type),
    amount_cents: pick(args.amount_cents, current.amount_cents),
    note: pick(args.note, current.note),
    paid_at: pick(optionalEpochMs(args.paid_at), current.paid_at),
    due_at: pick(optionalEpochMs(args.due_at), current.due_at),
    remind_at: pick(optionalEpochMs(args.remind_at), current.remind_at),
  };
  const result = await client.requestMobile<MobileEnvelope<BudgetPaymentRecord>>('PUT', '/v3/budgets/payments', body);
  return jsonResult(formatPayment(result.data));
}

export async function removeBudgetPayment(client: ZolaClient, args: { uuid: string }): Promise<ToolResult> {
  await client.requestMobile('DELETE', `/v3/budgets/payments/${args.uuid}`);
  return { content: [{ type: 'text', text: `Removed budget payment ${args.uuid}` }] };
}

export function registerBudgetTools(server: McpServer, client: ZolaClient): void {
  server.registerTool('get_budget', {
    description: 'Get the wedding budget summary including total budgeted, actual cost, paid, and all budget items',
    annotations: { readOnlyHint: true },
  }, () => getBudget(client));

  server.registerTool('update_budget_item', {
    description: "Update a budget item's actual cost and/or note by UUID",
    inputSchema: {
      uuid: z.string().describe('Budget item UUID from get_budget'),
      actual_cost_cents: z.number().optional().describe('Actual cost in cents'),
      note: z.string().optional().describe('Note for the budget item'),
    },
    annotations: { destructiveHint: false },
  }, (args) => updateBudgetItem(client, args));

  const dateArg = 'Date as YYYY-MM-DD or ISO 8601';

  server.registerTool('list_budget_payments', {
    description: 'List payments and reminders on the budget, optionally for one budget item',
    inputSchema: {
      item_uuid: z.string().optional().describe('Budget item UUID from get_budget; omit for all items'),
    },
    annotations: { readOnlyHint: true },
  }, (args) => listBudgetPayments(client, args));

  server.registerTool('add_budget_payment', {
    description: 'Add a payment (PAID) or upcoming payment/reminder (PENDING) to a budget item',
    inputSchema: {
      item_uuid: z.string().describe('Budget item UUID from get_budget'),
      payment_type: z.enum(['PAID', 'PENDING']).describe('PAID = already paid; PENDING = upcoming payment'),
      amount_cents: z.number().int().positive().describe('Amount in cents'),
      note: z.string().optional().describe('e.g. "Deposit (non-refundable)"'),
      due_at: z.string().optional().describe(`Due date. ${dateArg}`),
      paid_at: z.string().optional().describe(`Paid date (for PAID). ${dateArg}`),
      remind_at: z.string().optional().describe(`Reminder date (for PENDING). ${dateArg}`),
    },
    annotations: { destructiveHint: false },
  }, (args) => addBudgetPayment(client, args));

  server.registerTool('update_budget_payment', {
    description: 'Update a budget payment/reminder; omitted fields are kept, null clears a field',
    inputSchema: {
      uuid: z.string().describe('Payment UUID from list_budget_payments'),
      payment_type: z.enum(['PAID', 'PENDING']).optional(),
      amount_cents: z.number().int().positive().optional(),
      note: z.string().nullable().optional(),
      due_at: z.string().nullable().optional().describe(dateArg),
      paid_at: z.string().nullable().optional().describe(dateArg),
      remind_at: z.string().nullable().optional().describe(dateArg),
    },
    annotations: { destructiveHint: false },
  }, (args) => updateBudgetPayment(client, args));

  server.registerTool('remove_budget_payment', {
    description: 'Delete a budget payment/reminder',
    inputSchema: { uuid: z.string().describe('Payment UUID from list_budget_payments') },
    annotations: { destructiveHint: true },
  }, (args) => removeBudgetPayment(client, args));
}
