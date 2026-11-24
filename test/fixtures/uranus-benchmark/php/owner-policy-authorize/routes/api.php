<?php
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Auth;
use App\Models\Invoice;

Route::middleware('auth:sanctum')->group(function () {
    Route::delete('/invoices/{id}', function ($id) {
        $invoice = Invoice::findOrFail($id);
        Gate::authorize('delete', $invoice);
        $invoice->delete();
        return response()->noContent();
    });
});
