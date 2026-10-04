from django.http import JsonResponse
from .models import Product

def search(request):
    term = request.GET.get('q', '')
    products = Product.objects.raw(f"SELECT * FROM shop_product WHERE name LIKE '%{term}%'")  # expect: SEC-001
    return JsonResponse({'ids': [p.id for p in products]})
