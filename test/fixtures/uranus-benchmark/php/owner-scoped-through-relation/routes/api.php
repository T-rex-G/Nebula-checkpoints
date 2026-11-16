<?php
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Auth;
use App\Models\Invoice;

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/invoices/{id}', function ($id) {
        return Auth::user()->invoices()->findOrFail($id);
    });
});
