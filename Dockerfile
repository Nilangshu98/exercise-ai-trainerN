FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY python/requirements.txt python/requirements.txt
RUN pip install --no-cache-dir -r python/requirements.txt

COPY . .
RUN mkdir -p models dataset

ENV PYTHONUNBUFFERED=1
CMD ["python", "python/ml_service.py"]