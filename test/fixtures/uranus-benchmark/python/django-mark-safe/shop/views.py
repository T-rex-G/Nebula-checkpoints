from django.http import HttpResponse
from django.utils.safestring import mark_safe

def banner(request):
    return HttpResponse(mark_safe(request.GET.get('message', '')))  # expect: SEC-033
