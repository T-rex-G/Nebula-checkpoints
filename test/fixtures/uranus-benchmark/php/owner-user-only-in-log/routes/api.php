<?php
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Auth;
use App\Models\Invoice;

Route::middleware('auth:sanctum')->group(function () {
    Route::delete('/invoices/{id}', function ($id) { // expect: ACC-002 to-confirm
        logger()->info('deleted', ['user_id' => Auth::id()]);
        Invoice::findOrFail($id)->delete();
        return response()->noContent();
    });
});
