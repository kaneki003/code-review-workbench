import * as vscode from 'vscode';
import type { CheckoutDocuments } from '../../domain/checkout';

export function createCheckoutDocuments(): CheckoutDocuments {
  return {
    save: async () => await vscode.workspace.saveAll(false),
  };
}
