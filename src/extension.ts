import * as vscode from 'vscode';
import { PgmEditorProvider } from './pgmEditor';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(PgmEditorProvider.register(context));
}

export function deactivate(): void { }
