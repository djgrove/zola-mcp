import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { client } from '../src/client.js';
import {
  getBudget,
  updateBudgetItem,
  listBudgetPayments,
  addBudgetPayment,
  updateBudgetPayment,
  removeBudgetPayment,
} from '../src/tools/budget.js';
import { setupClientMocks } from './_fixtures.js';

const MOCK_BUDGET_ITEM = {
  uuid: '8b90d700-c891-46f9-87c5-f0f8b786b457',
  taxonomy_node_uuid: 'node-uuid-1',
  title: 'Venue',
  cost_cents: 2456900,
  estimate: false,
  estimated_cost_cents: 441411,
  actual_cost_cents: 2456900,
  item_type: { key: 'VENUE', display_name: 'Venue' },
  paid_cents: 75000,
  note: 'Original note',
  // Real API shape: the linked vendor is a nested object, not a flat uuid.
  account_vendor: { uuid: 'vendor-uuid-1', vendor_name: 'Biddle Ranch Vineyard', vendor_image: null },
  payments: [
    {
      uuid: 'payment-uuid-1',
      budget_item_uuid: '8b90d700-c891-46f9-87c5-f0f8b786b457',
      payment_type: 'PAID',
      amount_cents: 75000,
      note: null,
      paid_at: 1743019200000,
      due_at: 1737676800000,
      remind_at: null,
    },
  ],
};

const MOCK_BUDGET_RESPONSE = {
  data: {
    uuid: 'budget-uuid-1',
    budgeted_cents: 3000000,
    cost_cents: 5015490,
    paid_cents: 75000,
    balance_due_cents: 2381900,
    taxonomy_nodes: [
      {
        title: 'Essential vendors',
        items: [MOCK_BUDGET_ITEM],
      },
    ],
  },
};

describe('budget tools', () => {
  let reqSpy: ReturnType<typeof vi.spyOn<typeof client, 'requestMobile'>>;

  beforeEach(() => {
    reqSpy = setupClientMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getBudget: calls mobile API and returns flat summary with items', async () => {
    reqSpy.mockResolvedValueOnce(MOCK_BUDGET_RESPONSE as never);

    const result = await getBudget(client);

    expect(reqSpy).toHaveBeenCalledWith('GET', '/v3/budgets');
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.budgeted_cents).toBe(3000000);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].uuid).toBe('8b90d700-c891-46f9-87c5-f0f8b786b457');
    expect(parsed.items[0].title).toBe('Venue');
    expect(parsed.items[0].item_type).toBe('VENUE');
    expect(parsed.items[0].payment_count).toBe(1);
    expect(parsed.items[0].taxonomy_node_uuid).toBe('node-uuid-1');
    expect(parsed.items[0].account_vendor_uuid).toBe('vendor-uuid-1');
    expect(parsed.items[0].account_vendor_name).toBe('Biddle Ranch Vineyard');
  });

  it('updateBudgetItem: GETs budget via mobile, PUTs with correct body format', async () => {
    const updatedItem = { ...MOCK_BUDGET_ITEM, actual_cost_cents: 2600000, note: 'Updated note' };
    reqSpy
      .mockResolvedValueOnce(MOCK_BUDGET_RESPONSE as never)
      .mockResolvedValueOnce({ data: updatedItem } as never);

    const result = await updateBudgetItem(client, {
      uuid: '8b90d700-c891-46f9-87c5-f0f8b786b457',
      actual_cost_cents: 2600000,
      note: 'Updated note',
    });

    expect(reqSpy).toHaveBeenCalledTimes(2);
    expect(reqSpy).toHaveBeenNthCalledWith(1, 'GET', '/v3/budgets');
    expect(reqSpy).toHaveBeenNthCalledWith(2, 'PUT', '/v3/budgets/items', {
      item_uuid: '8b90d700-c891-46f9-87c5-f0f8b786b457',
      taxonomy_node_uuid: 'node-uuid-1',
      estimated_cost_cents: 441411,
      actual_cost_cents: 2600000,
      note: 'Updated note',
      item_type: 'VENUE',
      title: 'Venue',
      account_vendor_uuid: 'vendor-uuid-1',
    });
    expect(result.content[0].text).toContain('Venue');
    expect(result.content[0].text).toContain('2600000');
  });

  it('updateBudgetItem: throws descriptive error when uuid not found', async () => {
    const emptyBudget = { data: { ...MOCK_BUDGET_RESPONSE.data, taxonomy_nodes: [] } };
    reqSpy.mockResolvedValueOnce(emptyBudget as never);

    await expect(
      updateBudgetItem(client, { uuid: 'nonexistent-uuid' })
    ).rejects.toThrow('Budget item with UUID "nonexistent-uuid" not found');
  });

  it('updateBudgetItem: omits account_vendor_uuid for an unlinked item', async () => {
    const unlinked = { ...MOCK_BUDGET_ITEM, account_vendor: null };
    const budget = { data: { ...MOCK_BUDGET_RESPONSE.data, taxonomy_nodes: [{ title: 'x', items: [unlinked] }] } };
    reqSpy
      .mockResolvedValueOnce(budget as never)
      .mockResolvedValueOnce({ data: unlinked } as never);

    await updateBudgetItem(client, { uuid: unlinked.uuid, note: 'n' });

    const body = reqSpy.mock.calls[1][2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('account_vendor_uuid');
  });

  describe('payments', () => {
    const PAYMENT = {
      uuid: 'payment-uuid-2',
      budget_item_uuid: MOCK_BUDGET_ITEM.uuid,
      budget_item_title: 'Venue',
      payment_type: 'PENDING',
      amount_cents: 520400,
      note: 'Balance',
      paid_at: null,
      due_at: Date.UTC(2027, 4, 15, 12),
      remind_at: Date.UTC(2027, 4, 8, 12),
    };

    it('listBudgetPayments: flattens payments across items with ISO dates', async () => {
      reqSpy.mockResolvedValueOnce(MOCK_BUDGET_RESPONSE as never);

      const result = await listBudgetPayments(client, {});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        uuid: 'payment-uuid-1',
        budget_item_title: 'Venue',
        payment_type: 'PAID',
        paid_at: new Date(1743019200000).toISOString(),
        remind_at: null,
      });
    });

    it('listBudgetPayments: throws when item_uuid not found', async () => {
      reqSpy.mockResolvedValueOnce(MOCK_BUDGET_RESPONSE as never);
      await expect(listBudgetPayments(client, { item_uuid: 'nope' })).rejects.toThrow(
        'Budget item with UUID "nope" not found'
      );
    });

    it('addBudgetPayment: POSTs item_uuid and pins date-only strings to noon UTC', async () => {
      reqSpy.mockResolvedValueOnce({ data: PAYMENT } as never);

      await addBudgetPayment(client, {
        item_uuid: MOCK_BUDGET_ITEM.uuid,
        payment_type: 'PENDING',
        amount_cents: 520400,
        note: 'Balance',
        due_at: '2027-05-15',
        remind_at: '2027-05-08',
      });

      expect(reqSpy).toHaveBeenCalledWith('POST', '/v3/budgets/payments', {
        item_uuid: MOCK_BUDGET_ITEM.uuid,
        payment_type: 'PENDING',
        amount_cents: 520400,
        note: 'Balance',
        paid_at: null,
        due_at: Date.UTC(2027, 4, 15, 12),
        remind_at: Date.UTC(2027, 4, 8, 12),
      });
    });

    it('addBudgetPayment: rejects an unparseable date before calling the API', async () => {
      await expect(
        addBudgetPayment(client, { item_uuid: 'x', payment_type: 'PAID', amount_cents: 1, paid_at: 'someday' })
      ).rejects.toThrow('Invalid date "someday"');
      expect(reqSpy).not.toHaveBeenCalled();
    });

    it('updateBudgetPayment: read-modify-writes with payment_uuid, null clears a field', async () => {
      reqSpy
        .mockResolvedValueOnce({ data: PAYMENT } as never)
        .mockResolvedValueOnce({ data: { ...PAYMENT, payment_type: 'PAID' } } as never);

      await updateBudgetPayment(client, {
        uuid: 'payment-uuid-2',
        payment_type: 'PAID',
        paid_at: '2027-05-10',
        remind_at: null,
      });

      expect(reqSpy).toHaveBeenNthCalledWith(1, 'GET', '/v3/budgets/payments/payment-uuid-2');
      expect(reqSpy).toHaveBeenNthCalledWith(2, 'PUT', '/v3/budgets/payments', {
        payment_uuid: 'payment-uuid-2',
        item_uuid: MOCK_BUDGET_ITEM.uuid,
        payment_type: 'PAID',
        amount_cents: 520400,
        note: 'Balance',
        paid_at: Date.UTC(2027, 4, 10, 12),
        due_at: PAYMENT.due_at,
        remind_at: null,
      });
    });

    it('removeBudgetPayment: DELETEs by uuid', async () => {
      reqSpy.mockResolvedValueOnce({ data: null } as never);

      const result = await removeBudgetPayment(client, { uuid: 'payment-uuid-2' });

      expect(reqSpy).toHaveBeenCalledWith('DELETE', '/v3/budgets/payments/payment-uuid-2');
      expect(result.content[0].text).toContain('payment-uuid-2');
    });
  });
});
