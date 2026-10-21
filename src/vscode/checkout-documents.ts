import * as vscode from 'vscode';
import type { CheckoutDocuments } from '../application/checkout-review';

export function createCheckoutDocuments(): CheckoutDocuments {
  return {
    save: async () => await vscode.workspace.saveAll(false),
  };
}
