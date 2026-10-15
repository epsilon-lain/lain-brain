FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ZIP_OUTPUT_DIR=/app/track_2b/outputs
WORKDIR /app
COPY track_2b /app/track_2b
RUN mkdir -p /app/track_2b/outputs && python -m compileall -q /app/track_2b/src
EXPOSE 7860
ENTRYPOINT ["python", "track_2b/src/app.py"]
CMD ["--host", "0.0.0.0", "--port", "7860"]
