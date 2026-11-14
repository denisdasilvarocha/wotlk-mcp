FROM --platform=linux/amd64 mysql@sha256:106d5197fd8e4892980469ad42eb20f7a336bd81509aae4ee175d852f5cc4565 AS certificates
FROM --platform=linux/arm64 ubuntu@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5
COPY --from=certificates /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem /etc/ssl/certs/ca-certificates.crt
ENV DEBIAN_FRONTEND=noninteractive
RUN rm /etc/apt/sources.list.d/ubuntu.sources && \
    printf 'deb [check-valid-until=no] http://snapshot.ubuntu.com/ubuntu/20261114T000000Z noble main universe\ndeb [check-valid-until=no] http://snapshot.ubuntu.com/ubuntu/20261114T000000Z noble-updates main universe\ndeb [check-valid-until=no] http://snapshot.ubuntu.com/ubuntu/20261114T000000Z noble-security main universe\n' > /etc/apt/sources.list && \
    apt-get update && apt-get install -y --no-install-recommends build-essential cmake ninja-build git default-mysql-client default-libmysqlclient-dev libboost-all-dev libssl-dev libreadline-dev zlib1g-dev libbz2-dev libncurses-dev liblzma-dev ca-certificates patch && rm -rf /var/lib/apt/lists/*
