from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from .models import Order

@login_required
def order(request, order_id):
    o = get_object_or_404(Order, pk=order_id, user=request.user)
    return JsonResponse({'id': o.id, 'total': o.total})
