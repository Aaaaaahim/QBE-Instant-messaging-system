#include "threadpool.h"

#include <iostream>
#include <utility>

ThreadPool& ThreadPool::instance(size_t thread_count, size_t max_queue_size) {
	// C++11 guarantees thread-safe static initialization.
	static ThreadPool inst(thread_count, max_queue_size);
	return inst;
}

// Constructed via instance().
ThreadPool::ThreadPool(size_t count, size_t max_queue_size) {
	thread_count_ = count;
	if (thread_count_ == 0) thread_count_ = std::thread::hardware_concurrency();
	if (thread_count_ == 0) thread_count_ = 1;  // fallback
	if (max_queue_size == 0) max_queue_size = 1;
	task_max_count_ = max_queue_size;
	std::cout << "thread count: " << thread_count_ << std::endl;
}

ThreadPool::~ThreadPool() {
	// Ensure all threads stopped.
	stop();
}

void ThreadPool::start() {
	{
		std::lock_guard<std::mutex> guard(queue_mutex_);
		if (running_) return;
		running_ = true;
	}
	// Recreate threads after stop().
	threads_.clear();
	threads_.reserve(thread_count_);
	for (size_t i = 0; i < thread_count_; ++i) {
		threads_.emplace_back([this]() { worker_thread(); });
	}
}

void ThreadPool::worker_thread() {
	for (;;) {
		std::function<void()> task;
		{
			std::unique_lock<std::mutex> guard(queue_mutex_);
			wake_threads_.wait(guard, [this]() {
				return !running_ || !task_queue_.empty();
			});
			if (!running_ && task_queue_.empty()) break;
			task = std::move(task_queue_.front());
			task_queue_.pop();
			space_available_.notify_one();
		}
		if (task) task();
	}
}

void ThreadPool::add_task(std::function<void()> func) {
	{
		std::unique_lock<std::mutex> guard(queue_mutex_);
		if (!running_) return;
		space_available_.wait(guard, [this]() {
			return !running_ || task_queue_.size() < task_max_count_;
		});
		if (!running_) return;
		task_queue_.push(std::move(func));
	}
	wake_threads_.notify_one();
}

bool ThreadPool::try_add_task(std::function<void()> task) {
	{
		std::lock_guard<std::mutex> guard(queue_mutex_);
		if (!running_) return false;
		if (task_queue_.size() >= task_max_count_) return false;
		task_queue_.push(std::move(task));
	}
	wake_threads_.notify_one();
	return true;
}

void ThreadPool::stop() {
	{
		std::lock_guard<std::mutex> guard(queue_mutex_);
		if (!running_) return;
		running_ = false;
	}
	// Wake all workers to exit after draining.
	wake_threads_.notify_all();
	space_available_.notify_all();

	// Join threads before returning.
	for (auto& t : threads_) {
		if (t.joinable()) t.join();
	}
	threads_.clear();
}
